// GST Tax Invoice PDF builder — replicates the Tally print layout of
// sample invoice #528 (boxed item table + HSN/GST summary + amount in
// words + signatory block).
//
// Single supplier: American Hairline Pvt Ltd (Mumbai), GSTIN
// 05AABCQ0544P1ZB. Constants below mirror the invoice header exactly.
//
// ₹ glyph: Helvetica (built-in) has no rupee sign. If a rupee-capable
// TTF is present at public/fonts/NotoSans-{Regular,Bold}.ttf we register
// it and render "₹"; otherwise we fall back to "Rs." (same compromise as
// the payment receipt). Drop the two font files in to get the ₹ glyph.

import fs from "node:fs";
import path from "node:path";
import React from "react";
import {
  Document,
  Font,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";

// --------------------------------------------------------------------
// Supplier (constant — single GSTIN).
// --------------------------------------------------------------------
const SUPPLIER = {
  name: "AMERICAN HAIRLINE PVT LTD (MUMBAI)",
  address: "HARIDWAR,UTTARAKHAND",
  gstin: "05AABCQ0544P1ZB",
  stateName: "Uttarakhand",
  stateCode: "05",
};

// --------------------------------------------------------------------
// Optional rupee-capable font.
// --------------------------------------------------------------------
let RUPEE_FONT_OK = false;
try {
  const reg = path.join(process.cwd(), "public", "fonts", "NotoSans-Regular.ttf");
  const bold = path.join(process.cwd(), "public", "fonts", "NotoSans-Bold.ttf");
  if (fs.existsSync(reg) && fs.existsSync(bold)) {
    Font.register({
      family: "NotoSans",
      fonts: [
        { src: reg, fontWeight: "normal" },
        { src: bold, fontWeight: "bold" },
      ],
    });
    RUPEE_FONT_OK = true;
  }
} catch {
  RUPEE_FONT_OK = false;
}

const RUPEE = RUPEE_FONT_OK ? "₹ " : "Rs. ";
const rupeeFontStyle = RUPEE_FONT_OK
  ? { fontFamily: "NotoSans", fontWeight: 700 as const }
  : { fontFamily: "Helvetica-Bold" };

// --------------------------------------------------------------------
// Column layout — header / body / total stay aligned (widths sum 100).
// --------------------------------------------------------------------
const COLS = {
  sl: "5%",
  particulars: "32%",
  hsn: "11%",
  gst: "7%",
  qty: "11%",
  rateIncl: "12%",
  rate: "8%",
  per: "4%",
  amount: "10%",
};

const BORDER = "#000";

const styles = StyleSheet.create({
  page: {
    paddingTop: 24,
    paddingBottom: 20,
    paddingHorizontal: 28,
    fontFamily: "Helvetica",
    fontSize: 8,
    color: "#000",
  },

  // Top "Invoice No. / Dated" strip.
  topRow: { flexDirection: "row", justifyContent: "space-between" },
  topItem: { fontSize: 8 },
  topBold: { fontFamily: "Helvetica-Bold" },

  // Centered supplier block.
  centerBlock: { alignItems: "center", marginTop: 2, marginBottom: 4 },
  supplierName: { fontSize: 10, fontFamily: "Helvetica-Bold" },
  supplierLine: { fontSize: 8, marginTop: 1 },
  title: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 6, marginBottom: 4 },

  // Party block.
  partyWrap: { marginBottom: 4 },
  partyRow: { flexDirection: "row" },
  partyLabel: { width: 70 },
  partyName: { fontFamily: "Helvetica-Bold" },

  // Generic grid: container draws top+left, cells draw right+bottom.
  table: { borderTopWidth: 1, borderLeftWidth: 1, borderColor: BORDER },
  row: { flexDirection: "row" },
  cell: {
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: BORDER,
    paddingHorizontal: 3,
    paddingVertical: 2,
  },
  cellHead: { fontFamily: "Helvetica-Bold", textAlign: "center" },
  right: { textAlign: "right" },
  center: { textAlign: "center" },
  bold: { fontFamily: "Helvetica-Bold" },

  // Item body — tall spacer pushes the Total row to the bottom.
  spacerCell: { borderRightWidth: 1, borderColor: BORDER, minHeight: 220 },

  amountWords: { marginTop: 4, flexDirection: "row", justifyContent: "space-between" },
  wordsLabel: { fontSize: 8 },
  wordsValue: { fontFamily: "Helvetica-Bold", marginTop: 1 },

  signWrap: { marginTop: 18, alignItems: "flex-end" },
  signFor: { fontFamily: "Helvetica-Bold" },
  signAuth: { marginTop: 26, fontSize: 8 },

  computerGen: {
    marginTop: 10,
    textAlign: "center",
    fontSize: 7,
    color: "#333",
    textDecoration: "underline",
  },
});

export interface TaxInvoiceData {
  invoiceNumber: string; // Tally number, or "DRAFT" before sync
  invoiceDateIso: string; // rendered d-MMM-yy in IST
  party: {
    name: string;
    address?: string | null;
    stateName: string;
    stateCode: string;
    gstin?: string | null;
  };
  placeOfSupply: string;
  description: string;
  hsn: string;
  gstRatePct: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  total: number;
  amountInWords: string; // total in words
  taxInWords: string; // total tax in words
}

function amt(n: number): string {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function tallyDate(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleString("en-IN", { day: "numeric", timeZone: "Asia/Kolkata" });
  const mon = d.toLocaleString("en-IN", { month: "short", timeZone: "Asia/Kolkata" });
  const yr = d.toLocaleString("en-IN", { year: "2-digit", timeZone: "Asia/Kolkata" });
  return `${day}-${mon}-${yr}`;
}

export async function buildTaxInvoicePdf(data: TaxInvoiceData): Promise<Buffer> {
  const interState = data.igst > 0;

  // Particulars sub-lines + their right-column amounts, kept in lockstep.
  const taxLines = interState
    ? [{ label: "Output IGST", value: data.igst }]
    : [
        { label: "Output CGST", value: data.cgst },
        { label: "Output SGST", value: data.sgst },
      ];
  if (data.roundOff !== 0) {
    taxLines.push({ label: "Round Off", value: data.roundOff });
  }

  const rate = data.gstRatePct;
  const halfRate = rate / 2;

  const doc = (
    <Document title={`Tax Invoice ${data.invoiceNumber}`} author={SUPPLIER.name}>
      <Page size="A4" style={styles.page}>
        {/* Invoice No. / Dated */}
        <View style={styles.topRow}>
          <Text style={styles.topItem}>
            Invoice No. <Text style={styles.topBold}>{data.invoiceNumber}</Text>
          </Text>
          <Text style={styles.topItem}>
            Dated <Text style={styles.topBold}>{tallyDate(data.invoiceDateIso)}</Text>
          </Text>
        </View>

        {/* Supplier */}
        <View style={styles.centerBlock}>
          <Text style={styles.supplierName}>{SUPPLIER.name}</Text>
          <Text style={styles.supplierLine}>{SUPPLIER.address}</Text>
          <Text style={styles.supplierLine}>GSTIN/UIN: {SUPPLIER.gstin}</Text>
          <Text style={styles.supplierLine}>
            State Name : {SUPPLIER.stateName}, Code : {SUPPLIER.stateCode}
          </Text>
          <Text style={styles.title}>Tax Invoice</Text>
        </View>

        {/* Party */}
        <View style={styles.partyWrap}>
          <View style={styles.partyRow}>
            <Text style={styles.partyLabel}>Party :</Text>
            <Text style={styles.partyName}>{data.party.name}</Text>
          </View>
          {data.party.address ? (
            <View style={styles.partyRow}>
              <Text style={styles.partyLabel} />
              <Text>{data.party.address}</Text>
            </View>
          ) : null}
          <View style={styles.partyRow}>
            <Text style={styles.partyLabel}>State Name :</Text>
            <Text>
              {data.party.stateName}, Code : {data.party.stateCode}
            </Text>
          </View>
          <View style={styles.partyRow}>
            <Text style={styles.partyLabel}>Place of Supply :</Text>
            <Text>{data.placeOfSupply}</Text>
          </View>
          {data.party.gstin ? (
            <View style={styles.partyRow}>
              <Text style={styles.partyLabel}>GSTIN/UIN :</Text>
              <Text>{data.party.gstin}</Text>
            </View>
          ) : null}
        </View>

        {/* Item table */}
        <View style={styles.table}>
          {/* Header */}
          <View style={styles.row}>
            <Text style={[styles.cell, styles.cellHead, { width: COLS.sl }]}>Sl{"\n"}No.</Text>
            <Text style={[styles.cell, styles.cellHead, { width: COLS.particulars }]}>Particulars</Text>
            <Text style={[styles.cell, styles.cellHead, { width: COLS.hsn }]}>HSN/SAC</Text>
            <Text style={[styles.cell, styles.cellHead, { width: COLS.gst }]}>GST{"\n"}Rate</Text>
            <Text style={[styles.cell, styles.cellHead, { width: COLS.qty }]}>Quantity</Text>
            <Text style={[styles.cell, styles.cellHead, { width: COLS.rateIncl }]}>Rate{"\n"}(Incl. of Tax)</Text>
            <Text style={[styles.cell, styles.cellHead, { width: COLS.rate }]}>Rate</Text>
            <Text style={[styles.cell, styles.cellHead, { width: COLS.per }]}>per</Text>
            <Text style={[styles.cell, styles.cellHead, { width: COLS.amount }]}>Amount</Text>
          </View>

          {/* Body row — particulars + amount cells stack in lockstep */}
          <View style={styles.row}>
            <Text style={[styles.cell, styles.center, { width: COLS.sl }]}>1</Text>
            <View style={[styles.cell, { width: COLS.particulars }]}>
              <Text style={styles.bold}>{data.description}</Text>
              {taxLines.map((t) => (
                <Text key={t.label} style={[styles.bold, { textAlign: "right", marginTop: 2 }]}>
                  {t.label}
                </Text>
              ))}
            </View>
            <Text style={[styles.cell, styles.center, { width: COLS.hsn }]}>{data.hsn}</Text>
            <Text style={[styles.cell, styles.center, { width: COLS.gst }]}>{rate} %</Text>
            <Text style={[styles.cell, { width: COLS.qty }]} />
            <Text style={[styles.cell, { width: COLS.rateIncl }]} />
            <Text style={[styles.cell, { width: COLS.rate }]} />
            <Text style={[styles.cell, { width: COLS.per }]} />
            <View style={[styles.cell, { width: COLS.amount }]}>
              <Text style={[styles.bold, styles.right]}>{amt(data.taxableValue)}</Text>
              {taxLines.map((t) => (
                <Text key={t.label} style={[styles.bold, styles.right, { marginTop: 2 }]}>
                  {amt(t.value)}
                </Text>
              ))}
            </View>
          </View>

          {/* Tall spacer so Total sits at the page bottom like Tally */}
          <View style={styles.row}>
            <View style={[styles.spacerCell, { width: COLS.sl }]} />
            <View style={[styles.spacerCell, { width: COLS.particulars }]} />
            <View style={[styles.spacerCell, { width: COLS.hsn }]} />
            <View style={[styles.spacerCell, { width: COLS.gst }]} />
            <View style={[styles.spacerCell, { width: COLS.qty }]} />
            <View style={[styles.spacerCell, { width: COLS.rateIncl }]} />
            <View style={[styles.spacerCell, { width: COLS.rate }]} />
            <View style={[styles.spacerCell, { width: COLS.per }]} />
            <View style={[styles.spacerCell, { width: COLS.amount }]} />
          </View>

          {/* Total */}
          <View style={styles.row}>
            <Text style={[styles.cell, { width: COLS.sl }]} />
            <Text style={[styles.cell, styles.bold, styles.right, { width: COLS.particulars }]}>Total</Text>
            <Text style={[styles.cell, { width: COLS.hsn }]} />
            <Text style={[styles.cell, { width: COLS.gst }]} />
            <Text style={[styles.cell, { width: COLS.qty }]} />
            <Text style={[styles.cell, { width: COLS.rateIncl }]} />
            <Text style={[styles.cell, { width: COLS.rate }]} />
            <Text style={[styles.cell, { width: COLS.per }]} />
            <Text style={[styles.cell, styles.right, { width: COLS.amount }, rupeeFontStyle]}>
              {RUPEE}
              {amt(data.total)}
            </Text>
          </View>
        </View>

        {/* Amount in words */}
        <View style={styles.amountWords}>
          <Text style={styles.wordsLabel}>Amount Chargeable (in words)</Text>
          <Text style={{ fontStyle: "italic" }}>E. & O.E</Text>
        </View>
        <Text style={styles.wordsValue}>{data.amountInWords}</Text>

        {/* HSN / GST summary */}
        <View style={[styles.table, { marginTop: 8 }]}>
          {interState ? (
            <>
              <View style={styles.row}>
                <Text style={[styles.cell, styles.cellHead, { width: "40%" }]}>HSN/SAC</Text>
                <Text style={[styles.cell, styles.cellHead, { width: "20%" }]}>Taxable{"\n"}Value</Text>
                <Text style={[styles.cell, styles.cellHead, { width: "12%" }]}>IGST{"\n"}Rate</Text>
                <Text style={[styles.cell, styles.cellHead, { width: "14%" }]}>IGST{"\n"}Amount</Text>
                <Text style={[styles.cell, styles.cellHead, { width: "14%" }]}>Total{"\n"}Tax Amount</Text>
              </View>
              <View style={styles.row}>
                <Text style={[styles.cell, { width: "40%" }]}>{data.hsn}</Text>
                <Text style={[styles.cell, styles.right, { width: "20%" }]}>{amt(data.taxableValue)}</Text>
                <Text style={[styles.cell, styles.right, { width: "12%" }]}>{rate.toFixed(2)}%</Text>
                <Text style={[styles.cell, styles.right, { width: "14%" }]}>{amt(data.igst)}</Text>
                <Text style={[styles.cell, styles.right, { width: "14%" }]}>{amt(data.igst)}</Text>
              </View>
              <View style={styles.row}>
                <Text style={[styles.cell, styles.bold, styles.right, { width: "40%" }]}>Total</Text>
                <Text style={[styles.cell, styles.bold, styles.right, { width: "20%" }]}>{amt(data.taxableValue)}</Text>
                <Text style={[styles.cell, { width: "12%" }]} />
                <Text style={[styles.cell, styles.bold, styles.right, { width: "14%" }]}>{amt(data.igst)}</Text>
                <Text style={[styles.cell, styles.bold, styles.right, { width: "14%" }]}>{amt(data.igst)}</Text>
              </View>
            </>
          ) : (
            <>
              <View style={styles.row}>
                <Text style={[styles.cell, styles.cellHead, { width: "28%" }]}>HSN/SAC</Text>
                <Text style={[styles.cell, styles.cellHead, { width: "16%" }]}>Taxable{"\n"}Value</Text>
                <Text style={[styles.cell, styles.cellHead, { width: "10%" }]}>CGST{"\n"}Rate</Text>
                <Text style={[styles.cell, styles.cellHead, { width: "12%" }]}>CGST{"\n"}Amount</Text>
                <Text style={[styles.cell, styles.cellHead, { width: "10%" }]}>SGST{"\n"}Rate</Text>
                <Text style={[styles.cell, styles.cellHead, { width: "12%" }]}>SGST{"\n"}Amount</Text>
                <Text style={[styles.cell, styles.cellHead, { width: "12%" }]}>Total{"\n"}Tax Amount</Text>
              </View>
              <View style={styles.row}>
                <Text style={[styles.cell, { width: "28%" }]}>{data.hsn}</Text>
                <Text style={[styles.cell, styles.right, { width: "16%" }]}>{amt(data.taxableValue)}</Text>
                <Text style={[styles.cell, styles.right, { width: "10%" }]}>{halfRate.toFixed(2)}%</Text>
                <Text style={[styles.cell, styles.right, { width: "12%" }]}>{amt(data.cgst)}</Text>
                <Text style={[styles.cell, styles.right, { width: "10%" }]}>{halfRate.toFixed(2)}%</Text>
                <Text style={[styles.cell, styles.right, { width: "12%" }]}>{amt(data.sgst)}</Text>
                <Text style={[styles.cell, styles.right, { width: "12%" }]}>{amt(data.cgst + data.sgst)}</Text>
              </View>
              <View style={styles.row}>
                <Text style={[styles.cell, styles.bold, styles.right, { width: "28%" }]}>Total</Text>
                <Text style={[styles.cell, styles.bold, styles.right, { width: "16%" }]}>{amt(data.taxableValue)}</Text>
                <Text style={[styles.cell, { width: "10%" }]} />
                <Text style={[styles.cell, styles.bold, styles.right, { width: "12%" }]}>{amt(data.cgst)}</Text>
                <Text style={[styles.cell, { width: "10%" }]} />
                <Text style={[styles.cell, styles.bold, styles.right, { width: "12%" }]}>{amt(data.sgst)}</Text>
                <Text style={[styles.cell, styles.bold, styles.right, { width: "12%" }]}>{amt(data.cgst + data.sgst)}</Text>
              </View>
            </>
          )}
        </View>

        {/* Tax amount in words */}
        <Text style={{ marginTop: 4 }}>
          <Text style={styles.wordsLabel}>Tax Amount (in words) : </Text>
          <Text style={styles.bold}>{data.taxInWords}</Text>
        </Text>

        {/* Signatory */}
        <View style={styles.signWrap}>
          <Text style={styles.signFor}>for {SUPPLIER.name}</Text>
          <Text style={styles.signAuth}>Authorised Signatory</Text>
        </View>

        <Text style={styles.computerGen}>This is a Computer Generated Invoice</Text>
      </Page>
    </Document>
  );

  const buf = await renderToBuffer(doc);
  return buf as Buffer;
}
