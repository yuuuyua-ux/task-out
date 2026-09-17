import { execFile as systemExecFile } from 'node:child_process';
import path from 'node:path';

export const DIRECTORY_PICKER_TIMEOUT_MS = 120000;
const CANCELLED = '__TASK_OUT_DIRECTORY_CANCELLED__';
// No request input is interpolated into the script or passed to a shell.
// Showing hidden folders is necessary for common local agent data directories.
const SCRIPT = `try
  set selectedFolder to choose folder with prompt "选择要接入 Task Out 的会话数据目录" with invisibles
  return POSIX path of selectedFolder
on error number -128
  return "${CANCELLED}"
end try`;
const pickerError = (message, code, status = 503) => Object.assign(new Error(message), {code, status});

function failure(error, stderr = '') {
  const details = String(stderr || error?.stderr || error?.message || '');
  if (error?.killed || error?.code === 'ETIMEDOUT')
    return pickerError('选择目录已超时，请重试，或手动填写目录的完整路径。', 'DIRECTORY_PICKER_TIMEOUT', 408);
  if (['EACCES', 'EPERM'].includes(error?.code) || /\(-1743\)|\(-10004\)|not authorized|permission denied/i.test(details))
    return pickerError('系统未允许打开目录选择器，请在系统设置中检查权限，或手动填写目录的完整路径。', 'READ_PERMISSION', 403);
  return pickerError('暂时无法打开系统目录选择器，请手动填写目录的完整路径。', 'DIRECTORY_PICKER_UNAVAILABLE');
}

export function createDirectoryPicker({execFile = systemExecFile, platform = process.platform} = {}) {
  let active = false;
  return async function selectDirectory() {
    if (platform !== 'darwin') throw pickerError('当前系统暂不支持目录选择器，请手动填写目录的完整路径。', 'DIRECTORY_PICKER_UNAVAILABLE');
    if (active) throw pickerError('已有目录选择窗口打开，请先完成或取消该窗口。', 'DIRECTORY_PICKER_BUSY', 409);
    active = true;
    try {
      return await new Promise((resolve, reject) => {
        const finish = (error, stdout, stderr) => {
          if (error) {
            if (error.code === -128 || /\(-128\)/.test(String(stderr || error.stderr || error.message || ''))) {
              resolve({path: '', cancelled: true}); return;
            }
            reject(failure(error, stderr)); return;
          }
          const selected = typeof stdout === 'string' ? stdout.replace(/[\r\n]+$/, '') : '';
          if (selected === CANCELLED) { resolve({path: '', cancelled: true}); return; }
          if (!path.posix.isAbsolute(selected) || selected.includes('\0')) { reject(failure()); return; }
          resolve({path: selected, cancelled: false});
        };
        try {
          execFile('/usr/bin/osascript', ['-e', SCRIPT], {encoding: 'utf8', timeout: DIRECTORY_PICKER_TIMEOUT_MS,
            killSignal: 'SIGKILL', maxBuffer: 65536, windowsHide: true}, finish);
        } catch (error) { reject(failure(error)); }
      });
    } finally { active = false; }
  };
}

const nativePicker = createDirectoryPicker();
export async function selectDirectory() { return nativePicker(); }
