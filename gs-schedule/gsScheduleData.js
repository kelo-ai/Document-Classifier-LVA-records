// gsScheduleData.js
// Structured data extracted from GS-02: Records Retention and Disposition
// Schedule (Library of Virginia — County and Municipal Governments, Fiscal
// Records), effective 3/28/2024.
//
// This is intentionally just structured data, NOT yet embedded — per the
// task split, embedding generation is a separate step done later (see
// embeddingGenerator.js). Each record's "description" field (or a
// combination of fields) is what will get passed to the embedding model
// when that step is wired in.

const gsScheduleRecords = [
  {
    seriesNumber: '010143',
    seriesName: 'Accounts Payable',
    description: 'This series documents moneys to be paid by the locality to its creditors. This series may include, but is not limited to: invoices, receipts, bills, canceled checks, returned checks, check registers, and checking statements.',
    retentionPeriod: '3 Years after end of state fiscal year',
    dispositionMethod: 'Non-confidential Destruction'
  },
  {
    seriesNumber: '010144',
    seriesName: 'Accounts Receivable',
    description: 'This series documents moneys owed to the locality by its debtors. This series may include, but is not limited to: deposit receipts, invoices, bills, purchase orders, vouchers, permits, and receipt records.',
    retentionPeriod: '3 Years after end of state fiscal year',
    dispositionMethod: 'Non-confidential Destruction'
  },
  {
    seriesNumber: '010146',
    seriesName: 'Audit Records: External',
    description: "This series documents the audit of the finances of the locality by an outside auditing firm. This series may include, but is not limited to: locality's working papers and prepared audit report. COV 15.2-2511",
    retentionPeriod: 'Permanent, In Agency',
    dispositionMethod: 'Permanent, In Agency'
  },
  {
    seriesNumber: '010145',
    seriesName: 'Audit Records: Internal',
    description: 'This series documents the audits conducted by the locality on its various departments and agencies. This series may include, but is not limited to: audit report and work papers.',
    retentionPeriod: '8 Years after end of state fiscal year',
    dispositionMethod: 'Non-confidential Destruction'
  },
  {
    seriesNumber: '010150',
    seriesName: 'Budget Records: Adopted Budget Files',
    description: 'This series documents the adopted locality budget, outlining approved expenditures for the year.',
    retentionPeriod: 'Permanent, In Agency',
    dispositionMethod: 'Permanent, In Agency'
  },
  {
    seriesNumber: '010151',
    seriesName: 'Budget Records: Working Files',
    description: 'This series documents the budgeting process of the locality. This series may include, but is not limited to: working files.',
    retentionPeriod: '5 Years after end of state fiscal year',
    dispositionMethod: 'Non-confidential Destruction'
  },
  {
    seriesNumber: '200104',
    seriesName: 'Cash and Bank Reports',
    description: 'This series documents financial transactions within the locality. This series may include, but is not limited to: cash reports, transmittal and settlement records, warrant records, bank statements, and reconciliation documentation.',
    retentionPeriod: '3 Years after end of state fiscal year',
    dispositionMethod: 'Confidential Destruction'
  },
  {
    seriesNumber: '010159',
    seriesName: 'Contracts',
    description: 'This series documents contracts and agreements entered into by the locality. The series may include, but is not limited to: contract and supporting documentation.',
    retentionPeriod: '5 Years after expiration',
    dispositionMethod: 'Confidential Destruction'
  },
  {
    seriesNumber: '010162',
    seriesName: 'Financial Accounting Reports',
    description: 'This series documents the income and expenditures of the locality by its offices and agencies.',
    retentionPeriod: '3 Years after end of state fiscal year',
    dispositionMethod: 'Non-confidential Destruction'
  },
  {
    seriesNumber: '010163',
    seriesName: 'Fixed Assets Files',
    description: 'This series documents the control of fixed assets, such as land, buildings, and equipment, owned by the agency. This series may include, but is not limited to: logs, inventories, and reconciliation documents.',
    retentionPeriod: '0 Years after equipment, facility, or property sold or no longer in use',
    dispositionMethod: 'Non-confidential Destruction'
  },
  {
    seriesNumber: '010169',
    seriesName: 'General Ledger',
    description: 'This series documents the assets, liabilities, fund balances, revenues, and expenses of the locality. This series may include, but is not limited to: ledger, ledger cards, journals, and reports.',
    retentionPeriod: '10 Years after end of state fiscal year',
    dispositionMethod: 'Non-confidential Destruction'
  },
  {
    seriesNumber: '010164',
    seriesName: 'Grant Projects: Financials',
    description: 'This series documents the annual financial management of state, federal, and/or private grant projects participated in or awarded/administered by local agencies that do not contain contractual terms for records retention. This series may include, but is not limited to: accounts payables and receivables, draw-down requests, and fiscal reports.',
    retentionPeriod: '3 Years after end of state fiscal year',
    dispositionMethod: 'Non-confidential Destruction'
  },
  {
    seriesNumber: '010165',
    seriesName: 'Insurance Records and Reports',
    description: 'This series documents insurance coverage carried by the locality, such as commercial policies, third-party coverage, and self-insurance programs. This series may include, but is not limited to: insurance policies, claims, invoices, and investment files.',
    retentionPeriod: '3 Years after end of state fiscal year',
    dispositionMethod: 'Confidential Destruction'
  },
  {
    seriesNumber: '200105',
    seriesName: 'Payroll Records',
    description: 'This series documents the payroll activities of the locality. This series may include, but is not limited to: deduction authorizations and registers, leave records, ledgers and reports, compensation files, retirement contributions, time and attendance records, time sheets, Virginia Employment Commission (VEC) reports, wage and income tax reports, W-2 Wage and Tax Statements, and Form 1099.',
    retentionPeriod: '5 Years after end of state fiscal year',
    dispositionMethod: 'Confidential Destruction'
  },
  {
    seriesNumber: '200106',
    seriesName: 'Purchasing Records',
    description: 'This series documents the purchasing of equipment, goods, services, and supplies by the locality. This series may include, but is not limited to: bids, bid proposals, contracts, agreements, purchase orders, and requisitions.',
    retentionPeriod: '5 Years after end of state fiscal year',
    dispositionMethod: 'Confidential Destruction'
  },
  {
    seriesNumber: '010190',
    seriesName: 'Reimbursement Records',
    description: 'This series documents the reimbursement of money to or from the locality. This series may include, but is not limited to: travel expense reimbursement and overpayment documentation.',
    retentionPeriod: '3 Years after end of state fiscal year',
    dispositionMethod: 'Non-confidential Destruction'
  },
  {
    seriesNumber: '200107',
    seriesName: 'Retirement Files: Locally Managed Retirement System',
    description: 'This series documents the locally managed retirement system. This series may include, but is not limited to: employee participating and financial documentation.',
    retentionPeriod: '3 Years after last action',
    dispositionMethod: 'Confidential Destruction'
  },
  {
    seriesNumber: '010194',
    seriesName: 'Retirement Files: Virginia Retirement System (VRS)',
    description: 'This series documents the participation of the locality in the Virginia Retirement System.',
    retentionPeriod: '3 Years after end of state fiscal year',
    dispositionMethod: 'Confidential Destruction'
  },
  {
    seriesNumber: '200391',
    seriesName: 'Vendor / Supplier Records',
    description: 'This series documents the information of vendors and suppliers that provide goods and services. This series may include, but is not limited to: correspondence, W-9 and 1099 forms, Internal Revenue Service Taxpayer Identification Number (IRS TIN) match form, alternate payment address notice, and Automatic Clearing House (ACH) payment form.',
    retentionPeriod: '0 Years after no longer administratively useful',
    dispositionMethod: 'Confidential Destruction'
  },
  {
    seriesNumber: '010218',
    seriesName: "Workers' Compensation Records",
    description: 'This series documents claims filed based on work-related injury or illness. This series may include, but is not limited to: claims, application for benefits, wage documents used to determine compensation, and payment documentation.',
    retentionPeriod: '5 Years after end of state fiscal year',
    dispositionMethod: 'Confidential Destruction'
  }
];

module.exports = { gsScheduleRecords };
