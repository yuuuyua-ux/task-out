// These are transport/context envelopes emitted by supported clients, not
// conversation requests. Only remove envelopes at the start of a user entry;
// quoted examples, fenced code and tags within ordinary prose stay intact.
const REQUEST_TAGS = new Set(['current_user_request', 'command-args']);
const ENVELOPE = /^<(system-reminder|environment_context|user_instructions|recommended_plugins|app_instructions|codex_delegation|recovered_conversation_context|interrupted_turn_context|in-app-browser-context|local-command|command-name|command-message|local-command-stdout|current_user_request|command-args)\b[^>]*>/;

function envelopeEnd(text, opening) {
  if (/\/\s*>$/.test(opening[0])) return {body: '', end: opening[0].length};
  const tag = opening[1];
  // Match nested instances of the same tag. Tags quoted in code or blockquotes
  // are examples, not transport delimiters, including inside a request block.
  const tokens = new RegExp('```[\\s\\S]*?```|~~~[\\s\\S]*?~~~|`[^`\\n]*`|^[ \\t]*>[^\\n]*|<(/?)' + tag + '\\b[^>]*>', 'gm');
  tokens.lastIndex = opening[0].length;
  let depth = 1, token;
  while ((token = tokens.exec(text))) {
    if (token[1] === undefined) continue;
    if (token[1] === '/') depth--;
    else if (!/\/\s*>$/.test(token[0])) depth++;
    if (!depth) return {body: text.slice(opening[0].length, token.index), end: tokens.lastIndex};
  }
  return null;
}

function leadingContent(value, depth = 0) {
  if (depth > 32) return {text: '', incompleteRequest: true};
  let text = value.trim();
  const parts = [];
  let incompleteRequest = false;
  for (let count = 0; count < 64; count++) {
    const opening = text.match(ENVELOPE);
    if (!opening) { parts.push(text); break; }
    const envelope = envelopeEnd(text, opening);
    if (!envelope) {
      incompleteRequest ||= REQUEST_TAGS.has(opening[1]);
      break;
    }
    if (REQUEST_TAGS.has(opening[1])) {
      const content = leadingContent(envelope.body, depth + 1);
      parts.push(content.text); incompleteRequest ||= content.incompleteRequest;
    }
    text = text.slice(envelope.end).trim();
  }
  return {text: parts.filter(Boolean).join('\n'), incompleteRequest};
}

export function messageContent(role, value) {
  if (typeof value !== 'string') return {text: '', incompleteRequest: false};
  let text = value.trim();
  let incompleteRequest = false;
  if (role === 'user') {
    ({text, incompleteRequest} = leadingContent(text));
    if (/^# AGENTS\.md instructions\b/.test(text)) text = '';
    if (text.includes('## My request:') && !text.startsWith('```'))
      text = text.slice(text.lastIndexOf('## My request:') + '## My request:'.length).trim();
  }
  return {text: text.replace(/\s+/g, ' ').trim().slice(0, 1200), incompleteRequest};
}

export const meaningfulMessage = (role, value) => messageContent(role, value).text;
