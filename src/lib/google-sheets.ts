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

/**
 * Non-secret diagnostics about whether each env var is set and looks valid.
 * Used by the sync endpoint to give actionable errors instead of a vague "disabled".
 */
export function getSheetsEnvDiagnostics() {
  const email = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  return {
    GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL: {
      present: !!email,
      length: email?.length ?? 0,
      looksLikeEmail: !!email && email.includes("@") && email.includes(".iam.gserviceaccount.com")
    },
    GOOGLE_SHEETS_PRIVATE_KEY: {
      present: !!privateKey,
      length: privateKey?.length ?? 0,
      hasBeginMarker: !!privateKey && privateKey.includes("BEGIN PRIVATE KEY"),
      hasEndMarker: !!privateKey && privateKey.includes("END PRIVATE KEY")
    },
    GOOGLE_SHEETS_SPREADSHEET_ID: {
      present: !!spreadsheetId,
      length: spreadsheetId?.length ?? 0
    }
  };
}
