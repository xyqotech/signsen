import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import forge from "node-forge";

export type SealCheck =
  | {
      valid: true;
      signerSubject: string;
      certificateFingerprint: string;
      signingTime: Date | null;
    }
  | { valid: false; reason: "no_signature" | "modified_after_signing" | "digest_mismatch" | "bad_signature" | "unreadable" };

const OID_MESSAGE_DIGEST = forge.pki.oids.messageDigest;
const OID_SIGNING_TIME = forge.pki.oids.signingTime;

/**
 * Checks the last PKCS#7 detached signature of a PDF: it must cover the whole
 * file, its message digest must match the signed bytes, and the RSA signature
 * over the signed attributes must verify with the embedded certificate.
 * Trust in that certificate (whose seal it is) is decided by the caller.
 */
export function verifySeal(pdf: Buffer): SealCheck {
  const text = pdf.toString("latin1");
  const ranges = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  if (ranges.length === 0) return { valid: false, reason: "no_signature" };
  const [a, b, c, d] = ranges[ranges.length - 1].slice(1, 5).map(Number);
  if (a !== 0 || c + d !== pdf.length || b > c) return { valid: false, reason: "modified_after_signing" };

  try {
    const contents = text.slice(a + b, c).replace(/[<>\s]/g, "");
    const der = forge.util.hexToBytes(contents);
    // The Contents slot is zero-padded after the DER: parse without requiring
    // every byte to be consumed. (@types/node-forge still declares the old
    // boolean-only signature; the runtime accepts this options object.)
    const fromDer = forge.asn1.fromDer as unknown as (bytes: string, options: object) => forge.asn1.Asn1;
    const asn1 = fromDer(der, { strict: false, parseAllBytes: false });
    const p7 = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData & {
      rawCapture: { signerInfos: forge.asn1.Asn1[] };
    };
    const cert = p7.certificates[0];
    const signerInfo = p7.rawCapture.signerInfos?.[0];
    if (!cert || !signerInfo) return { valid: false, reason: "unreadable" };

    const parts = signerInfo.value as forge.asn1.Asn1[];
    const attrs = parts.find((p) => p.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && p.type === 0);
    const signature = parts.find((p) => p.tagClass === forge.asn1.Class.UNIVERSAL && p.type === forge.asn1.Type.OCTETSTRING);
    if (!attrs || !signature) return { valid: false, reason: "unreadable" };

    let messageDigest: string | null = null;
    let signingTime: Date | null = null;
    for (const attr of attrs.value as forge.asn1.Asn1[]) {
      const [oidNode, setNode] = attr.value as forge.asn1.Asn1[];
      const oid = forge.asn1.derToOid(oidNode.value as string);
      const value = (setNode.value as forge.asn1.Asn1[])[0];
      if (oid === OID_MESSAGE_DIGEST) messageDigest = forge.util.bytesToHex(value.value as string);
      if (oid === OID_SIGNING_TIME) {
        signingTime =
          value.type === forge.asn1.Type.UTCTIME
            ? forge.asn1.utcTimeToDate(value.value as string)
            : forge.asn1.generalizedTimeToDate(value.value as string);
      }
    }

    const signed = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
    const actual = createHash("sha256").update(signed).digest("hex");
    if (messageDigest !== actual) return { valid: false, reason: "digest_mismatch" };

    // The signature covers the DER of the attributes re-tagged as a SET. It is
    // checked with Node's crypto (OpenSSL), not node-forge: forge's RSA PKCS#1 v1.5
    // verification is lenient about the DigestInfo encoding (GHSA-86w9-cpqp-85rv).
    const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs.value as forge.asn1.Asn1[]);
    const signedAttributes = Buffer.from(forge.asn1.toDer(set).getBytes(), "binary");
    const publicKey = createPublicKey(forge.pki.certificateToPem(cert));
    const ok = cryptoVerify("sha256", signedAttributes, publicKey, Buffer.from(signature.value as string, "binary"));
    if (!ok) return { valid: false, reason: "bad_signature" };

    const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const fp = forge.md.sha256.create();
    fp.update(certDer);
    return {
      valid: true,
      signerSubject: cert.subject.attributes.map((x) => `${x.shortName}=${x.value}`).join(", "),
      certificateFingerprint: fp.digest().toHex().toUpperCase().match(/.{2}/g)!.join(":"),
      signingTime,
    };
  } catch {
    return { valid: false, reason: "unreadable" };
  }
}
