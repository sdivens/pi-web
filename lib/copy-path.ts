/**
 * A path as the clipboard should hold it: bare unless it needs quoting. A path
 * with whitespace (or a double quote) is wrapped in double quotes, so it can be
 * pasted into a shell as one word instead of splitting at the first space; a
 * double quote inside it is escaped, which is what bash, zsh, cmd and
 * PowerShell all read back as a literal one.
 *
 * Backslashes are left alone on purpose: escaping every one of them would turn
 * a Windows path ("C:\Users\me\my project") into something cmd and PowerShell
 * cannot open, and a path holding a double quote is the rare case that needs
 * the escape at all. `$` and a backtick stay literal too (a double-quoted shell
 * word would expand them); neither shows up in a real folder name.
 *
 * The sidebar's group menu and the session info panel both copy paths through
 * this, so one path pastes the same from either place.
 */
export function copyablePath(path: string): string {
  if (!/[\s"]/.test(path)) return path;
  return `"${path.replace(/"/g, '\\"')}"`;
}
