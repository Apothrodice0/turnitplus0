import crypto from "node:crypto";

/**
 * Shared test-fixture helper (not product code): builds a real, standards-
 * correct password-protected PDF using the PDF 1.4 standard security
 * handler (Revision 2, 40-bit RC4), so adversarial tests can exercise
 * pdfjs's real PasswordException path rather than a fake/simulated one.
 * RC4 is implemented directly (KSA+PRGA) rather than via node:crypto's
 * 'rc4' cipher, which some OpenSSL builds disable as a legacy algorithm.
 */

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k += 1) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

function md5(buffer) {
  return crypto.createHash("md5").update(buffer).digest();
}

const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function padPassword(password) {
  const pw = Buffer.from(password, "latin1").subarray(0, 32);
  return Buffer.concat([pw, PAD], 32);
}

function buildEncryptedPdfSecurityHandler({ userPassword, ownerPassword, permissions, fileId }) {
  const pBuffer = Buffer.alloc(4);
  pBuffer.writeInt32LE(permissions, 0);

  const ownerKeyFull = md5(padPassword(ownerPassword));
  const ownerKey = ownerKeyFull.subarray(0, 5);
  const O = rc4(ownerKey, padPassword(userPassword));

  const keyMaterial = Buffer.concat([padPassword(userPassword), O, pBuffer, fileId]);
  const encryptionKey = md5(keyMaterial).subarray(0, 5);

  const U = rc4(encryptionKey, PAD);

  return { O, U, encryptionKey };
}

export function buildMinimalEncryptedPdf() {
  const fileId = crypto.randomBytes(16);
  const userPassword = "user-secret-1";
  const ownerPassword = "owner-secret-1";
  const permissions = -44; // the PDF 1.4 spec's own worked example value for Algorithm 3.2
  const { O, U } = buildEncryptedPdfSecurityHandler({ userPassword, ownerPassword, permissions, fileId });

  const escape = (buf) => buf.toString("latin1").replace(/([()\\])/g, "\\$1");
  const idHex = fileId.toString("hex").toUpperCase();

  const objects = [];
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  objects.push("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n");
  objects.push(`4 0 obj\n<< /Filter /Standard /V 1 /R 2 /O (${escape(O)}) /U (${escape(U)}) /P ${permissions} >>\nendobj\n`);

  let body = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += obj;
  }
  const xrefOffset = Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(body + xref + trailer, "latin1");
}
