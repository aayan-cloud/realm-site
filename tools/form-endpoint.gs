/**
 * The backend for start.html. Google Apps Script, so it costs nothing and the
 * enquiries land in a Google Sheet Aayan owns rather than on someone else's
 * form service.
 *
 * DEPLOY ONCE (about two minutes):
 *
 *   1. Open a new Google Sheet. Extensions > Apps Script.
 *   2. Delete whatever is in Code.gs, paste this whole file, Save.
 *   3. Deploy > New deployment > type "Web app".
 *        Execute as:        Me
 *        Who has access:    Anyone            <- must be Anyone, not "Anyone with
 *                                                the link", or the fetch is blocked
 *      Deploy, then Authorize access and pick the Google account that owns the sheet.
 *   4. Copy the /exec URL it gives you, and paste it into ENDPOINT at the bottom
 *      of start.html. Commit and push. The form is live.
 *
 * To redeploy after editing this file: Deploy > Manage deployments > the pencil
 * icon > Version: New version > Deploy. The /exec URL does not change.
 */

var SHEET_NAME = 'Enquiries';

var COLUMNS = [
  'when', 'business', 'trade', 'city', 'want', 'site', 'contact', 'detail', 'page',
];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var sheet = openSheet_();

    sheet.appendRow(COLUMNS.map(function (key) {
      if (key === 'when') return new Date();
      return String(body[key] == null ? '' : body[key]).slice(0, 2000);
    }));

    notify_(body);
    return reply_({ ok: true });
  } catch (err) {
    // Still 200 - a thrown error in Apps Script returns an HTML error page the
    // browser cannot read, so the form would report a failure it cannot explain.
    return reply_({ ok: false, error: String(err) });
  }
}

/** A GET is only ever a human checking the URL works. */
function doGet() {
  return reply_({ ok: true, note: 'Realm Systems enquiry endpoint. POST JSON here.' });
}

function openSheet_() {
  var doc = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = doc.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = doc.insertSheet(SHEET_NAME);
    sheet.appendRow(COLUMNS);
    sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Mail to whoever owns the script, so an enquiry is not just a row nobody sees. */
function notify_(body) {
  var to = Session.getEffectiveUser().getEmail();
  if (!to) return;
  MailApp.sendEmail({
    to: to,
    subject: 'Realm Systems enquiry - ' + (body.business || 'no name') + ' (' + (body.city || '?') + ')',
    body: COLUMNS
      .filter(function (k) { return k !== 'when'; })
      .map(function (k) { return k + ': ' + (body[k] || '-'); })
      .join('\n'),
  });
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
