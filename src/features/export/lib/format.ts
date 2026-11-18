export function precise(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--.---";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes.toString().padStart(2, "0")}:${rest
    .toFixed(3)
    .padStart(6, "0")}`;
}

export function bytesLabel(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}
