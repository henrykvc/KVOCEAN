import { google, type sheets_v4 } from "googleapis";

export type SheetsConfig = {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  sheetName: string;
};

export function getSheetsConfig(): SheetsConfig | null {
  const email = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL;
  const privateKeyRaw = process.env.GOOGLE_SHEETS_PRIVATE_KEY;
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

  if (!email || !privateKeyRaw || !spreadsheetId) {
    return null;
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  return {
    sheets: google.sheets({ version: "v4", auth }),
    spreadsheetId,
    sheetName: process.env.GOOGLE_SHEETS_TAB_NAME ?? "최종결과물"
  };
}
