export const MAX_MESSAGE = 8000;
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function validateFiles(files: File[]) {
  if (files.length > MAX_FILES) return `Choose up to ${MAX_FILES} files.`;
  for (const file of files) {
    if (file.type !== "application/pdf" && !file.type.startsWith("image/")) {
      return `${file.name} is not an image or PDF.`;
    }
    if (file.size > MAX_FILE_BYTES) {
      return `${file.name} is larger than 10 MB.`;
    }
  }
  return null;
}
