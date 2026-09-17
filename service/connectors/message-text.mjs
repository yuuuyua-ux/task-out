// These are transport/context envelopes emitted by supported clients, not
// conversation requests. Only remove envelopes at the start of a user entry;
// quoted examples, fenced code and tags within ordinary prose stay intact.
const ENVELOPE = /^<(system-reminder|environment_context|user_instructions|recommended_plugins|app_instructions|codex_delegation|recovered_conversation_context|in-app-browser-context|local-command|command-name|command-message|local-command-stdout)\b[^>]*>/;

export function meaningfulMessage(role, value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  if (role === 'user') {
    let match;
    while ((match = text.match(ENVELOPE))) {
      const close = `</${match[1]}>`, end = text.indexOf(close, match[0].length);
      // Old cached excerpts can end inside an envelope. Do not promote its
      // truncated instructions or a later conversation turn into the title.
      if (end < 0) return '';
      text = text.slice(end + close.length).trim();
    }
    if (/^# AGENTS\.md instructions\b/.test(text)) return '';
    if (text.includes('## My request:') && !text.startsWith('```'))
      text = text.slice(text.lastIndexOf('## My request:') + '## My request:'.length).trim();
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 1200);
}
