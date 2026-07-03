// Branded payment receipt PDF builder.
//
// Generates an A4 single-page PDF using @react-pdf/renderer. The PDF
// gets uploaded to Supabase Storage by sendReceiptInternal and then
// pushed to the client on WhatsApp as a document attachment.
//
// Note: Helvetica (the built-in font) does not include the ₹ glyph, so
// the amount is rendered as "Rs. 1,234.00". The WhatsApp caption that
// accompanies the document still uses ₹.

import fs from "node:fs";
import path from "node:path";
import React from "react";
import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";

// --------------------------------------------------------------------
// Edit these constants to customise the receipt branding. Operators can
// later swap this for a Settings → Branding section if per-salon
// overrides are needed.
// --------------------------------------------------------------------
const CLINIC_NAME = "QHT Mediways Private Limited";
const CLINIC_TAGLINE = "Hair Treatment Salon";
const SUPPORT_EMAIL = "info@americanhairline.com";
const SUPPORT_WEBSITE = "americanhairline.com";
const NOTES: string[] = [
  "Booking amount is valid for 1 year.",
  "Treatment may be denied to patients in case the client is found unfit for surgery.",
];
const TERMS: string[] = [
  "Booking amount is 100% refundable.",
  "Booking refund should only be initiated on 4th and 19th of every month. Approved refunds might take 7-8 business days to process. The time may vary based on the payment method (e.g., credit card, Phone Pay etc.).",
  "Show this receipt at the salon's reception while coming for treatment.",
  "Treatment date may change in case of any emergency or pandemic factors.",
];
// --------------------------------------------------------------------

let cachedLogo: Buffer | null = null;
function getLogo(): Buffer | null {
  if (cachedLogo) return cachedLogo;
  try {
    cachedLogo = fs.readFileSync(
      path.join(process.cwd(), "public", "logo.png"),
    );
    return cachedLogo;
  } catch {
    return null;
  }
}

const styles = StyleSheet.create({
  page: {
    paddingTop: 32,
    paddingBottom: 32,
    paddingHorizontal: 36,
    fontFamily: "Helvetica",
    fontSize: 10,
    color: "#0f172a",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 18,
  },
  brandLeft: { flexDirection: "row", alignItems: "center" },
  logo: { width: 48, height: 48, objectFit: "contain", marginRight: 10 },
  brandTextWrap: { flexDirection: "column" },
  brandName: { fontSize: 14, fontFamily: "Helvetica-Bold", color: "#0f172a" },
  brandTagline: { fontSize: 9, color: "#64748b", marginTop: 2 },
  receiptHead: { flexDirection: "column", alignItems: "flex-end" },
  receiptTitle: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    color: "#0f766e",
  },
  receiptMeta: { fontSize: 9, color: "#475569", marginTop: 2 },
  divider: {
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
    marginVertical: 10,
  },
  amountCard: {
    borderWidth: 1,
    borderColor: "#a7f3d0",
    backgroundColor: "#ecfdf5",
    borderRadius: 6,
    padding: 12,
    marginBottom: 14,
  },
  amountLabel: {
    fontSize: 9,
    color: "#047857",
    letterSpacing: 1,
  },
  amountValue: {
    fontSize: 22,
    fontFamily: "Helvetica-Bold",
    color: "#065f46",
    marginTop: 4,
  },
  amountFor: { fontSize: 10, color: "#0f172a", marginTop: 6 },
  detailsGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 4 },
  detailRow: { width: "50%", marginBottom: 8, paddingRight: 8 },
  detailLabel: {
    fontSize: 8,
    color: "#64748b",
    letterSpacing: 0.5,
  },
  detailValue: {
    fontSize: 10,
    color: "#0f172a",
    marginTop: 2,
    fontFamily: "Helvetica-Bold",
  },
  sectionLabel: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: "#0f172a",
    marginBottom: 6,
    marginTop: 4,
  },
  termsList: { marginTop: 2 },
  termItem: { fontSize: 8, color: "#475569", marginBottom: 3 },
  footer: {
    marginTop: 16,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    alignItems: "center",
  },
  footerThanks: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: "#0f766e",
  },
  footerLine: { fontSize: 8, color: "#64748b", marginTop: 3 },
});

export interface ReceiptData {
  receiptNumber: string;
  paidAtIso: string;
  amountMinor: number;
  currency: string;
  description: string | null;
  patientName: string;
  patientPhone: string;
  transactionId: string | null;
  provider: "razorpay" | "payu";
}

function formatINR(minor: number): string {
  return (
    "Rs. " +
    (minor / 100).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) {
    return "+91 " + digits.slice(2, 7) + " " + digits.slice(7);
  }
  if (digits.length === 10) {
    return "+91 " + digits.slice(0, 5) + " " + digits.slice(5);
  }
  return raw.startsWith("+") ? raw : "+" + digits;
}

export async function buildReceiptPdf(data: ReceiptData): Promise<Buffer> {
  const logo = getLogo();
  const amount = formatINR(data.amountMinor);
  const paidAt = formatDate(data.paidAtIso);
  const providerLabel = data.provider === "payu" ? "PayU" : "Razorpay";

  const doc = (
    <Document
      title={`QHT Receipt — ${data.receiptNumber}`}
      author={CLINIC_NAME}
    >
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View style={styles.brandLeft}>
            {logo ? <Image src={logo} style={styles.logo} /> : null}
            <View style={styles.brandTextWrap}>
              <Text style={styles.brandName}>{CLINIC_NAME}</Text>
              <Text style={styles.brandTagline}>{CLINIC_TAGLINE}</Text>
            </View>
          </View>
          <View style={styles.receiptHead}>
            <Text style={styles.receiptTitle}>PAYMENT RECEIPT</Text>
            <Text style={styles.receiptMeta}>
              Receipt #: {data.receiptNumber}
            </Text>
            <Text style={styles.receiptMeta}>Date: {paidAt}</Text>
          </View>
        </View>

        <View style={styles.amountCard}>
          <Text style={styles.amountLabel}>AMOUNT RECEIVED</Text>
          <Text style={styles.amountValue}>{amount}</Text>
          {data.description ? (
            <Text style={styles.amountFor}>For: {data.description}</Text>
          ) : null}
        </View>

        <View style={styles.detailsGrid}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>PATIENT NAME</Text>
            <Text style={styles.detailValue}>{data.patientName}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>PHONE</Text>
            <Text style={styles.detailValue}>
              {formatPhone(data.patientPhone)}
            </Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>PAYMENT GATEWAY</Text>
            <Text style={styles.detailValue}>{providerLabel}</Text>
          </View>
          {data.transactionId ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>TRANSACTION REFERENCE</Text>
              <Text style={styles.detailValue}>{data.transactionId}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.divider} />

        <Text style={styles.sectionLabel}>Notes</Text>
        <View style={styles.termsList}>
          {NOTES.map((t, i) => (
            <Text key={i} style={styles.termItem}>
              {i + 1}. {t}
            </Text>
          ))}
        </View>

        <Text style={styles.sectionLabel}>Terms & Conditions</Text>
        <View style={styles.termsList}>
          {TERMS.map((t, i) => (
            <Text key={i} style={styles.termItem}>
              {i + 1}. {t}
            </Text>
          ))}
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerThanks}>
            Thanks for your cooperation!
          </Text>
          <Text style={styles.footerLine}>
            {SUPPORT_EMAIL}  |  {SUPPORT_WEBSITE}
          </Text>
        </View>
      </Page>
    </Document>
  );

  const buf = await renderToBuffer(doc);
  return buf as Buffer;
}
