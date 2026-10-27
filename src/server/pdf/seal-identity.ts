import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import forge from "node-forge";
import type { AppConfig } from "../config";

export interface SealIdentity {
  /** PKCS#12 bundle (private key + certificate) used to seal final PDFs. */
  p12: Buffer;
  password: string;
  certificatePem: string;
  /** Human-readable subject, e.g. "CN=Acme document seal, O=Acme". */
  subject: string;
  /** SHA-256 fingerprint of the DER certificate, hex, colon-separated. */
  fingerprint: string;
  selfSigned: boolean;
}

/**
 * Loads the instance seal. When the operator provides none (SEAL_P12_PATH), a
 * self-signed one is generated once and kept in DATA_DIR/seal. A self-signed
 * seal proves integrity against this instance's published fingerprint; it does
 * not chain to any public trust list.
 */
export function loadSealIdentity(config: AppConfig): SealIdentity {
  if (config.seal.p12Path) {
    return describe(fs.readFileSync(config.seal.p12Path), config.seal.p12Password!, false);
  }
  const dir = path.join(config.dataDir, "seal");
  const p12File = path.join(dir, "seal.p12");
  const passFile = path.join(dir, "seal.pass");
  if (!fs.existsSync(p12File)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const password = randomBytes(24).toString("base64url");
    const p12 = generateSelfSignedP12(config.brand.name, password);
    fs.writeFileSync(passFile, password, { mode: 0o600 });
    fs.writeFileSync(p12File, p12, { mode: 0o600 });
  }
  return describe(fs.readFileSync(p12File), fs.readFileSync(passFile, "utf8").trim(), true);
}

export function generateSelfSignedP12(organisation: string, password: string, years = 10): Buffer {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const key = forge.pki.privateKeyFromPem(privateKey);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = "01" + randomBytes(15).toString("hex");
  const notBefore = new Date();
  notBefore.setMinutes(notBefore.getMinutes() - 5);
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + years);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  const attrs = [
    { name: "commonName", value: `${organisation} document seal` },
    { name: "organizationName", value: organisation },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(key, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert], password, { algorithm: "aes256" });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary");
}

function describe(p12: Buffer, password: string, selfSigned: boolean): SealIdentity {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12.toString("binary")));
  const parsed = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  const bags = parsed.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const cert = bags[0]?.cert;
  if (!cert) throw new Error("The seal PKCS#12 contains no certificate");
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);
  const fingerprint = md
    .digest()
    .toHex()
    .toUpperCase()
    .match(/.{2}/g)!
    .join(":");
  const subject = cert.subject.attributes.map((a) => `${a.shortName}=${a.value}`).join(", ");
  return { p12, password, certificatePem: forge.pki.certificateToPem(cert), subject, fingerprint, selfSigned };
}
