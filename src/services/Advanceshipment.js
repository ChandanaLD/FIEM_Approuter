// ═══════════════════════════════════════════════════════════════
// services/shipment.js
// Covers: Advanceshipment (ASN) page
// ═══════════════════════════════════════════════════════════════

const ODATA_BASE = '/sap/opu/odata/shiv/MO_SUPP_PORTAL_ASN_APP_SRV'

// ── base GET helper ──
async function odataGet(path) {
  const res = await fetch(`${ODATA_BASE}${path}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`)
  return res.json()
}

// ── value helpers ──
const num = (v) => Number(String(v ?? '').trim() || 0)
const str = (v) => String(v ?? '').trim()

// SAP "20260520" → "20.05.2026"
const sapDate = (v) => {
  const s = str(v)
  if (s.length !== 8) return s
  return `${s.slice(6, 8)}.${s.slice(4, 6)}.${s.slice(0, 4)}`
}

// SAP "122800" → "12:28:00"
const sapTime = (v) => {
  const s = str(v).padStart(6, '0')
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`
}

// ── status derivation ──
function deriveStatus(d) {
  if (d.Cancel === true || str(d.Cancel) === 'X') return { status: 'Cancelled', color: 'red' }
  if (str(d.Status)) {
    const s = str(d.Status)
    return { status: s, color: s.toLowerCase() === 'confirmed' ? 'blue' : 'red' }
  }
  if (str(d.Tagged) === 'X') return { status: 'Tagged', color: 'red' }
  if (str(d.Draft) === 'X') return { status: 'Draft', color: 'green' }
  return { status: 'Open', color: 'green' }
}

// ── mappers ──
function mapHeader(d) {
  const { status, color } = deriveStatus(d)
  const baseDoc = `${str(d.Type_text)} ${str(d.Order_num)}`.trim()
  return {
    id: `${str(d.Asn_Num)}/${str(d.FisYear)}`,
    asnNum: str(d.Asn_Num),
    fisYear: str(d.FisYear),
    amount: num(d.TotAmt),
    currency: str(d.currency) || 'INR',
    baseDocument: baseDoc,
    plant: str(d.Werks),
    plantName: str(d.Plant_des),
    date: sapDate(d.Invoice_Date),
    status,
    statusColor: color,
    vendor: str(d.Name1),
    generalData: {
      supplierInvoice: str(d.Invoice_Num),
      baseDocument: baseDoc,
      invoiceAmount: num(d.Invoice_Amt),
      invoiceDate: sapDate(d.Invoice_Date),
    },
    shipment: {
      trackingNo: str(d.TrackingNo),
      driverName: str(d.NameDrvr),
      contactNumber: str(d.DrvContactNum),
      transporterName: str(d.TransporterName),
      transportMode: str(d.Transport),
      vehicleRegNo: str(d.VehicleRegNumb),
      creationDate: sapDate(d.CreationDt),
      creationTime: sapTime(d.CreationTime),
    },
    items: [],
    taxSummary: { taxableValue: 0, igst: 0, cgst: 0, sgstUtgst: 0, unPlannedCost: 0, totalAmount: 0 },
    attachments: [],
  }
}

function mapItem(d) {
  return {
    deliveryDate: sapDate(d.Delv_dt),
    material: str(d.Mat_txt) || str(d.Material),
    quantity: num(d.Quantity),
    unit: str(d.Unit),
    amount: num(d.Net_price),
    hsnSac: str(d.HsnCode),
    igst: num(d.Tot_igst),
    cgst: num(d.Tot_cgst),
    sgstUtgst: num(d.Tot_sgst),
    unplannedCost: num(d.UnplannedCost),
  }
}

function mapAttachment(d) {
  const name = str(d.Filename)
  const mime = str(d.Mimetype) || str(d.__metadata?.content_type) || 'application/octet-stream'
  // SAP streams binary via media_src — this is the $value URL
  const mediaSrc = d.__metadata?.media_src || null
  return {
    name,
    type: mime.toLowerCase().includes('pdf') ? 'PDF' : 'FILE',
    mime,
    mediaSrc,  // ← direct $value stream URL from SAP
    // composite key fields for re-fetching if needed
    sernr: str(d.Sernr),
    dokvr: str(d.Dokvr),
  }
}

// ═══════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════
export const asnApi = {

  // GET /ASN_HEADERSet?$format=json
  async listAsns({ search = '', plants = [] } = {}) {
    const json = await odataGet('/ASN_HEADERSet?$format=json')
    let rows = (json.d?.results || []).map(mapHeader)
    const q = search.trim().toLowerCase()
    if (q) rows = rows.filter(a =>
      a.id.toLowerCase().includes(q) ||
      a.plantName.toLowerCase().includes(q) ||
      a.plant.toLowerCase().includes(q) ||
      a.baseDocument.toLowerCase().includes(q) ||
      a.vendor.toLowerCase().includes(q)
    )
    if (plants.length) rows = rows.filter(a => plants.includes(a.plant))
    return rows
  },

  // GET /ASN_HEADERSet(Asn_Num='...',FisYear='...')?$expand=Headertoitemnav&$format=json
  async getAsn(id) {
    const [asnNum, fisYear] = id.split('/')
    const json = await odataGet(
      `/ASN_HEADERSet(Asn_Num='${asnNum}',FisYear='${fisYear}')?$expand=Headertoitemnav&$format=json`
    )
    const d = json.d
    if (!d) return null

    const asn = mapHeader(d)
    const itemRows = d.Headertoitemnav?.results || []
    asn.items = itemRows.map(mapItem)

    // derive tax summary from items
    const sum = (k) => asn.items.reduce((t, it) => t + (it[k] || 0), 0)
    const taxable = sum('amount')
    const igst = sum('igst')
    const cgst = sum('cgst')
    const sgst = sum('sgstUtgst')
    const unplanned = sum('unplannedCost')
    asn.taxSummary = {
      taxableValue: taxable,
      igst, cgst, sgstUtgst: sgst,
      unPlannedCost: unplanned,
      totalAmount: taxable + igst + cgst + sgst + unplanned,
    }
    return asn
  },

  // GET /AsnAttachmentSet?$filter=AsnNum eq '...' and FisYear eq '...'&$format=json
  async getAttachments(asnNum, fisYear) {
    const filter = `AsnNum eq '${asnNum}' and FisYear eq '${fisYear}'`
    const json = await odataGet(
      `/AsnAttachmentSet?$filter=${encodeURIComponent(filter)}&$format=json`
    )
    return (json.d?.results || []).map(mapAttachment)
  },

  // Download — fetches binary from SAP media_src ($value endpoint)
  // Keys: AsnNum, FisYear, Sernr, Dokvr (from __metadata)
  async downloadAttachment(asnNum, fisYear, attachment) {
    const { name, mime, mediaSrc, sernr, dokvr } = attachment

    // Build $value URL — use media_src from record if present, else construct from keys
    const valueUrl = mediaSrc ||
      `${ODATA_BASE}/AsnAttachmentSet(AsnNum='${asnNum}',FisYear='${fisYear}',Sernr='${sernr}',Dokvr='${dokvr}')/$value`

    const res = await fetch(valueUrl, {
      headers: { Accept: mime || 'application/octet-stream' },
    })
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
    const blob = await res.blob()
    triggerDownload(blob, name)
  },

  // Print — log for now; wire to backend print endpoint when available
  async printAsn(id) {
    console.log('print requested for', id)
    return { success: true, id }
  },

  // Cancel — DELETE /ASN_HEADERSet(Asn_Num='...',FisYear='...')
  async cancelAsn(id) {
    const [asnNum, fisYear] = id.split('/')
    const res = await fetch(
      `${ODATA_BASE}/ASN_HEADERSet(Asn_Num='${asnNum}',FisYear='${fisYear}')`,
      { method: 'DELETE', headers: { Accept: 'application/json' } }
    )
    if (!res.ok) throw new Error(`Cancel failed: HTTP ${res.status}`)
    return { success: true, id }
  },
}

// ═══════════════════════════════════════════════════════════════
// PRIVATE UTILS
// ═══════════════════════════════════════════════════════════════


function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}