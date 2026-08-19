export const SKFIY_APP_PROCESS_PATTERN = "/skfiy\\.app/Contents/(MacOS|Frameworks)/";
export const SKFIY_GHOSTTY_SESSION_PROCESS_PATTERN =
  "/Applications/Ghostty.app/Contents/MacOS/ghostty --title=skfiy-shell";

const SKFIY_APP_PROCESS_REGEX = new RegExp(SKFIY_APP_PROCESS_PATTERN);
const SKFIY_GHOSTTY_SESSION_PROCESS_REGEX =
  /^\d+\s+\/Applications\/Ghostty\.app\/Contents\/MacOS\/ghostty(?:\s|$).*--title=skfiy-shell(?:\s|$)/;

export function isSkfiyAppProcessLine(line) {
  return SKFIY_APP_PROCESS_REGEX.test(String(line));
}

export function filterSkfiyAppProcessLines(lines) {
  return lines.filter((line) => isSkfiyAppProcessLine(line));
}

export function isSkfiyGhosttySessionProcessLine(line) {
  return SKFIY_GHOSTTY_SESSION_PROCESS_REGEX.test(String(line));
}

export function filterSkfiyGhosttySessionProcessLines(lines) {
  return lines.filter((line) => isSkfiyGhosttySessionProcessLine(line));
}

export function parseProcessIds(lines) {
  return lines.flatMap((line) => {
    const match = /^(\d+)\s+/.exec(String(line));
    return match ? [Number(match[1])] : [];
  });
}
