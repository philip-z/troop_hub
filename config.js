// Edit these values for your troop.
window.TROOP_CONFIG = {
  GOOGLE_CLIENT_ID: "YOUR_CLIENT_ID.apps.googleusercontent.com",
  SPREADSHEET_ID: "YOUR_SPREADSHEET_ID",
  // Link to the Google Form for equipment borrowed / assigned for cleaning / returned
  EQUIPMENT_FORM_URL: "https://forms.google.com/your-equipment-form",
  // Google account emails treated as leaders
  LEADER_EMAILS: ["leader@example.com"],
  // Sheet tab names. "Trips" must have a header row:
  // ID | Name | Date | Location | Cost | Description
  TABS: {
    trips: "Trips",
    slips: "PermissionSlips",
    receipts: "Receipts",
    payments: "Payments",
    reimbursements: "Reimbursements"
  }
};
