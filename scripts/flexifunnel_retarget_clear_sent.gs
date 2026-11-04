/**
 * FlexiFunnel — retarget WITHOUT n8n
 *
 * FLOW (Apps Script only):
 *  1) Find ONE row by phone on Whatsapp Import Data
 *  2) Clear ONLY Status (col N / Sent) on that row
 *  3) Immediately run existing CRM import (addDataToImportleadW)
 *     → lead lands in CRM as "New Lead"
 *     → import marks Sent again
 *
 * NO n8n. NO Sheets Update/Clear from n8n.
 *
 * LIVE: Deploy this project as Web App → LP/webhook POSTs JSON with phone.
 * TEST: Run testClearSent() in the editor (hardcoded phone for that run only).
 */

var RETARGET_CFG = {
  SPREADSHEET_ID: '178whhdEBgxDm1ar0SftrwSKDyO5bWeEk-o2eUCr1p74',
  SHEET_NAME: 'Whatsapp Import Data',
  HOURS_FOR_RETARGET: 24,
  COL: {
    DATE: 1,
    NAME: 2,
    FULL_PHONE: 3,
    PHONE: 4,
    CITY: 5,
    CAMPAIGN: 6,
    ADSET: 7,
    AD: 8,
    SOURCE: 9,
    PLACEMENT: 10,
    LEAD_SOURCE: 11,
    TRACKING: 12,
    HELPER: 13,
    STATUS: 14
  }
};

function digitsOnly_(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

function last10_(v) {
  var d = digitsOnly_(v);
  return d.length > 10 ? d.slice(-10) : d;
}

function phoneMatch_(a, b) {
  var da = digitsOnly_(a);
  var db = digitsOnly_(b);
  if (!da || !db) return false;
  if (da === db) return true;
  return last10_(da) === last10_(db);
}

function findImportRowByPhone_(sheet, phone) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  var values = sheet.getRange(2, 1, lastRow - 1, RETARGET_CFG.COL.STATUS).getValues();
  var want = digitsOnly_(phone);
  if (!want) return 0;

  for (var i = values.length - 1; i >= 0; i--) {
    var row = values[i];
    if (
      phoneMatch_(want, row[RETARGET_CFG.COL.FULL_PHONE - 1]) ||
      phoneMatch_(want, row[RETARGET_CFG.COL.PHONE - 1]) ||
      phoneMatch_(want, row[RETARGET_CFG.COL.HELPER - 1])
    ) {
      return i + 2;
    }
  }
  return 0;
}

/**
 * Call your existing Import → CRM function in this same Apps Script project.
 * Prefers addDataToImportleadW (addToImportLead.gs).
 */
function pushClearedRowToCrm_() {
  if (typeof addDataToImportleadW === 'function') {
    addDataToImportleadW();
    return 'addDataToImportleadW';
  }
  if (typeof addDataToImportlead === 'function') {
    addDataToImportlead();
    return 'addDataToImportlead';
  }
  if (typeof addNewLeadDataFormSheets === 'function') {
    addNewLeadDataFormSheets();
    return 'addNewLeadDataFormSheets';
  }
  return null;
}

/**
 * Is this click a retarget?
 * YES only if: Status is Sent (already imported) AND
 *   (older than 24h OR incoming campaign is non-empty and different)
 * Same-session / every random hit → NO (Sent stays).
 */
function isRetargetClick_(sheet, row, patch) {
  patch = patch || {};
  if (patch.forceRetarget === true) return { yes: true, reason: 'forced' };

  var status = String(sheet.getRange(row, RETARGET_CFG.COL.STATUS).getValue() || '').trim();
  if (status.toLowerCase() !== 'sent') {
    return { yes: false, reason: 'status_not_sent', status: status };
  }

  var dateVal = sheet.getRange(row, RETARGET_CFG.COL.DATE).getValue();
  var hours = 999;
  if (dateVal instanceof Date && !isNaN(dateVal.getTime())) {
    hours = (new Date().getTime() - dateVal.getTime()) / (1000 * 60 * 60);
  }

  var existingCampaign = String(sheet.getRange(row, RETARGET_CFG.COL.CAMPAIGN).getValue() || '').trim();
  var incomingCampaign = String(patch.campaignName || '').trim();
  var newCampaign = incomingCampaign && incomingCampaign !== existingCampaign;

  if (hours > RETARGET_CFG.HOURS_FOR_RETARGET) {
    return { yes: true, reason: 'older_than_24h', hours: hours };
  }
  if (newCampaign) {
    return { yes: true, reason: 'new_campaign', incomingCampaign: incomingCampaign, existingCampaign: existingCampaign };
  }

  return { yes: false, reason: 'same_session', hours: hours, status: status };
}

/**
 * Clear Sent + CRM push — ONLY for retarget clicks.
 * Same-session numbers hitting doPost are ignored (Sent stays).
 */
function retargetLeadByPhone_(phone, patch) {
  patch = patch || {};
  var ss = SpreadsheetApp.openById(RETARGET_CFG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(RETARGET_CFG.SHEET_NAME);
  if (!sheet) {
    return { ok: false, row: 0, action: 'error', message: 'Sheet not found: ' + RETARGET_CFG.SHEET_NAME };
  }

  var row = findImportRowByPhone_(sheet, phone);
  if (!row) {
    return { ok: false, row: 0, action: 'not_found', message: 'No Import row for phone ' + phone };
  }

  var gate = isRetargetClick_(sheet, row, patch);
  if (!gate.yes) {
    return {
      ok: true,
      row: row,
      action: 'skipped_not_retarget',
      reason: gate.reason,
      message: 'Not a retarget (' + gate.reason + '). Sent left as-is. No CRM push.'
    };
  }

  // ONLY Status — never wipe other columns/rows
  sheet.getRange(row, RETARGET_CFG.COL.STATUS).clearContent();

  if (patch.refreshDate !== false) {
    sheet.getRange(row, RETARGET_CFG.COL.DATE).setValue(new Date());
  }
  if (patch.name) sheet.getRange(row, RETARGET_CFG.COL.NAME).setValue(String(patch.name));
  if (patch.city) sheet.getRange(row, RETARGET_CFG.COL.CITY).setValue(String(patch.city));
  if (patch.campaignName) sheet.getRange(row, RETARGET_CFG.COL.CAMPAIGN).setValue(String(patch.campaignName));
  if (patch.adSetName) sheet.getRange(row, RETARGET_CFG.COL.ADSET).setValue(String(patch.adSetName));
  if (patch.adName) sheet.getRange(row, RETARGET_CFG.COL.AD).setValue(String(patch.adName));
  if (patch.campaignSource) sheet.getRange(row, RETARGET_CFG.COL.SOURCE).setValue(String(patch.campaignSource));
  if (patch.placement) sheet.getRange(row, RETARGET_CFG.COL.PLACEMENT).setValue(String(patch.placement));
  if (patch.trackingId) sheet.getRange(row, RETARGET_CFG.COL.TRACKING).setValue(String(patch.trackingId));

  SpreadsheetApp.flush();

  var crmFn = pushClearedRowToCrm_();
  if (!crmFn) {
    return {
      ok: true,
      row: row,
      action: 'cleared_sent_only',
      reason: gate.reason,
      message: 'Sent cleared on row ' + row + ' (retarget: ' + gate.reason + '), but no addDataToImportleadW() in project.'
    };
  }

  return {
    ok: true,
    row: row,
    action: 'cleared_sent_and_pushed_crm',
    reason: gate.reason,
    crmFunction: crmFn,
    message: 'Retarget (' + gate.reason + '): cleared Sent on row ' + row + ', ran ' + crmFn + ' → CRM New Lead.'
  };
}

/** Keep old name working */
function clearSentForPhone_(phone, patch) {
  return retargetLeadByPhone_(phone, patch);
}

/**
 * Editor test only — change phone to a row that exists in Import.
 * Production never uses this; doPost uses the phone from the request.
 */
function testClearSent() {
  // forceRetarget: true bypasses the 24h/campaign check for manual testing only
  var result = retargetLeadByPhone_('919167868154', {
    refreshDate: true,
    campaignName: 'TEST_RETARGET',
    forceRetarget: true
  });
  Logger.log(JSON.stringify(result));
}

/**
 * LIVE entry — Landing page / WhatsApp webhook POSTs here directly.
 * No n8n in the middle.
 */
function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    if (body.body && typeof body.body === 'object') body = body.body;
    var vars = body.vars || {};

    var phone = body.wa_id || body.phone || body.FullPhone || '';
    var patch = {
      refreshDate: true,
      name: body.wa_name || vars.user_name || vars.name || body.name || '',
      city: vars.city || body.city || '',
      campaignName: vars.CampaignName || body.campaign_name || '',
      adSetName: vars.AdSetName || body.adset_name || '',
      adName: vars.AdName || body.ad_name || '',
      campaignSource: vars.CampaignSource || body.campaign_source || body.utm_source || '',
      placement: vars.Placement || body.placement || '',
      trackingId: body.wa_tracking || vars.wa_tracking || vars.Path || body.tracking_id || ''
    };

    var result = retargetLeadByPhone_(phone, patch);
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, message: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, service: 'flexifunnel-retarget-apps-script-only' }))
    .setMimeType(ContentService.MimeType.JSON);
}
