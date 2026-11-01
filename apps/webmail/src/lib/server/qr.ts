import qrcode from "qrcode-generator";

/**
 * QR code drawn on the server as a data: SVG. Never an external QR service: the TOTP secret
 * would travel in its URL.
 */
export function qrDataUri(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
