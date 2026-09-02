import { linearClient } from "../config/clients.js";

/** Linear's two-step upload: ask for a pre-signed URL, PUT the bytes to it, then reference the returned assetUrl in an issue/comment body. */
export async function uploadImageToLinear(buffer: Buffer, filename: string, contentType: string): Promise<string> {
  const payload = await linearClient.fileUpload(contentType, filename, buffer.length);
  const uploadFile = payload.uploadFile;
  if (!payload.success || !uploadFile) {
    throw new Error("Linear fileUpload did not return an upload target.");
  }

  const headers = new Headers({ "Content-Type": contentType });
  for (const { key, value } of uploadFile.headers) {
    headers.set(key, value);
  }

  const putRes = await fetch(uploadFile.uploadUrl, { method: "PUT", headers, body: buffer });
  if (!putRes.ok) {
    throw new Error(`Upload to Linear's asset storage failed (${putRes.status}).`);
  }

  return uploadFile.assetUrl;
}

/** Appends a markdown image to an issue's description so it renders inline in Linear. */
export async function appendImageToIssueDescription(issueId: string, assetUrl: string, altText: string): Promise<void> {
  const issue = await linearClient.issue(issueId);
  const description = `${issue.description ?? ""}\n\n![${altText}](${assetUrl})\n`;
  await linearClient.updateIssue(issueId, { description });
}
