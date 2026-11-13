/**
 * Evaluation cases: what a supervisor or supplier actually sends, and what a
 * careful project engineer would take from it. Written by hand.
 *
 * Progress is checked to within 10 percentage points, because supervisors
 * estimate. Worker counts and material quantities must match exactly.
 */

import type { SiteContext } from "../src/agents/site-agent.js";

export const siteContext = (language: "en" | "am"): SiteContext => ({
  projectName: "Bole G+4 Apartments",
  logDate: "2026-11-12",
  supervisorName: "Abebe Kebede",
  language,
  activities: [
    { code: "B2100", name: "Floor 1 columns", zone: "Block A floor 1", unit: "m3", percentComplete: 61 },
    { code: "B2110", name: "Floor 1 beam and slab formwork", zone: "Block A floor 1", unit: "m2", percentComplete: 5 },
    { code: "B2120", name: "Floor 1 slab reinforcement", zone: "Block A floor 1", unit: "ton", percentComplete: 0 },
    { code: "B2130", name: "Pour floor 1 slab", zone: "Block A floor 1", unit: "m3", percentComplete: 0 },
    { code: "B3000", name: "Ground floor HCB blockwork", zone: "Block A ground floor", unit: "m2", percentComplete: 40 },
    { code: "B3010", name: "Ground floor electrical and plumbing rough-in", zone: "Block A ground floor", unit: null, percentComplete: 10 },
    { code: "B3020", name: "Ground floor internal plastering", zone: "Block A ground floor", unit: "m2", percentComplete: 0 },
    { code: "B5200", name: "Septic tank, drainage and paving", zone: "External works", unit: "m", percentComplete: 20 },
  ],
  materials: [
    { name: "Cement", unit: "bag" },
    { name: "Rebar", unit: "ton" },
    { name: "HCB blocks", unit: "pcs" },
    { name: "Sand", unit: "m3" },
    { name: "Aggregate", unit: "m3" },
  ],
  previous: null,
});

type IssueKind = "delay" | "safety" | "quality" | "material" | "weather" | "information" | "other";

export interface SiteCase {
  id: string;
  group: "English" | "English, informal" | "Amharic" | "Amharic and English mixed" | "Hard cases";
  language: "en" | "am";
  text: string;
  expect: {
    workers: number;
    /** Activity code to percent complete after the day. */
    progress: Record<string, number>;
    used?: Record<string, number>;
    received?: Record<string, number>;
    /** Each entry is one issue that must be reported; any of the listed kinds counts. */
    issues?: IssueKind[][];
  };
}

export const siteCases: SiteCase[] = [
  // Plain English
  {
    id: "en-1",
    group: "English",
    language: "en",
    text: "Today 10 masons and 8 labourers. Floor 1 columns finished. Ground floor blockwork reached about 60%. Used 35 bags of cement and 1200 HCB blocks.",
    expect: { workers: 18, progress: { B2100: 100, B3000: 60 }, used: { Cement: 35, "HCB blocks": 1200 } },
  },
  {
    id: "en-2",
    group: "English",
    language: "en",
    text: "Formwork for the floor 1 slab is around 40 percent. 6 carpenters and 4 labourers on site. 15 m3 of sand delivered, no problems today.",
    expect: { workers: 10, progress: { B2110: 40 }, received: { Sand: 15 } },
  },
  {
    id: "en-3",
    group: "English",
    language: "en",
    text: "Electricians finished the ground floor conduits, so electrical and plumbing rough-in is now about 50% overall. 3 electricians and 2 plumbers. Nothing delivered.",
    expect: { workers: 5, progress: { B3010: 50 } },
  },
  {
    id: "en-4",
    group: "English",
    language: "en",
    text: "Rain all morning, we only worked after lunch. 12 labourers on the septic tank and drainage, which is around 35 percent now.",
    expect: { workers: 12, progress: { B5200: 35 }, issues: [["weather"]] },
  },
  {
    id: "en-5",
    group: "English",
    language: "en",
    text: "Steel fixers started the floor 1 slab reinforcement, maybe 15% done. 5 steel fixers. Used 1.2 tons of rebar. One worker cut his hand on a bar, first aid given and he went home.",
    expect: { workers: 5, progress: { B2120: 15 }, used: { Rebar: 1.2 }, issues: [["safety"]] },
  },
  {
    id: "en-6",
    group: "English",
    language: "en",
    text: "No work today, public holiday. Site closed.",
    expect: { workers: 0, progress: {} },
  },
  {
    id: "en-7",
    group: "English",
    language: "en",
    text: "Blockwork is at 70 percent. Cement finished on site, we have zero bags left and need a delivery urgently. 9 masons and 6 helpers.",
    expect: { workers: 15, progress: { B3000: 70 }, issues: [["material"]] },
  },
  {
    id: "en-8",
    group: "English",
    language: "en",
    text: "Still waiting for the consultant to approve the slab reinforcement drawings, so the steel fixers could not start. 4 carpenters continued the formwork, now 55%.",
    expect: { workers: 4, progress: { B2110: 55 }, issues: [["information", "delay"]] },
  },

  // Informal English, the way it is typed on a phone
  {
    id: "inf-1",
    group: "English, informal",
    language: "en",
    text: "colums fl1 done!! blokwork gf ~65%. 11 masons 7 lab. cem 30 bags used",
    expect: { workers: 18, progress: { B2100: 100, B3000: 65 }, used: { Cement: 30 } },
  },
  {
    id: "inf-2",
    group: "English, informal",
    language: "en",
    text: "formwork 1st flr bout half way. 5 carp. got 20 cube aggregate n 10 cube sand",
    expect: { workers: 5, progress: { B2110: 50 }, received: { Aggregate: 20, Sand: 10 } },
  },
  {
    id: "inf-3",
    group: "English, informal",
    language: "en",
    text: "plastering not started yet. elec/plumb 30pct. 2 elec 2 plumb 1 helper",
    expect: { workers: 5, progress: { B3010: 30 } },
  },
  {
    id: "inf-4",
    group: "English, informal",
    language: "en",
    text: "sorry late report. drainage 45%, 10 daily labour. pump broke down for 2 hrs",
    expect: { workers: 10, progress: { B5200: 45 }, issues: [["delay", "other", "quality"]] },
  },
  {
    id: "inf-5",
    group: "English, informal",
    language: "en",
    text: "today slab rebar 25%, 6 fixers, used 2 ton steel. also 800 blocks came in",
    expect: { workers: 6, progress: { B2120: 25 }, used: { Rebar: 2 }, received: { "HCB blocks": 800 } },
  },
  {
    id: "inf-6",
    group: "English, informal",
    language: "en",
    text: "masons 8 laborers 10 blockwork going ok 55 percent, used 25 bag cement 900 block",
    expect: { workers: 18, progress: { B3000: 55 }, used: { Cement: 25, "HCB blocks": 900 } },
  },

  // Amharic
  {
    id: "am-1",
    group: "Amharic",
    language: "am",
    text: "ዛሬ 10 ግንበኞች እና 8 የቀን ሰራተኞች ነበሩ። የአንደኛ ፎቅ ኮለኖች ተጠናቀዋል። የመሬት ወለል ብሎኬት ግንብ 60 በመቶ ደርሷል። 35 ከረጢት ሲሚንቶ ተጠቅመናል።",
    expect: { workers: 18, progress: { B2100: 100, B3000: 60 }, used: { Cement: 35 } },
  },
  {
    id: "am-2",
    group: "Amharic",
    language: "am",
    text: "የአንደኛ ፎቅ ፎርምወርክ 40 በመቶ ደርሷል። 6 አናጺዎች ነበሩ። 15 ሜትር ኪዩብ አሸዋ ገብቷል።",
    expect: { workers: 6, progress: { B2110: 40 }, received: { Sand: 15 } },
  },
  {
    id: "am-3",
    group: "Amharic",
    language: "am",
    text: "ጠዋት ሙሉ ዝናብ ስለነበር ከሰዓት በኋላ ብቻ ሰራን። 12 የቀን ሰራተኞች የሴፕቲክ ታንክ እና የፍሳሽ ማስወገጃ ስራ ላይ ነበሩ፣ 35 በመቶ ደርሷል።",
    expect: { workers: 12, progress: { B5200: 35 }, issues: [["weather"]] },
  },
  {
    id: "am-4",
    group: "Amharic",
    language: "am",
    text: "የብረት ሰራተኞች የአንደኛ ፎቅ ስላብ ብረት ስራ ጀምረዋል፣ 15 በመቶ ገደማ። 5 የብረት ሰራተኞች ነበሩ። 1.2 ቶን ብረት ተጠቅመናል።",
    expect: { workers: 5, progress: { B2120: 15 }, used: { Rebar: 1.2 } },
  },
  {
    id: "am-5",
    group: "Amharic",
    language: "am",
    text: "ሲሚንቶ ሙሉ በሙሉ አልቋል፣ በአስቸኳይ ያስፈልገናል። የብሎኬት ግንብ 70 በመቶ ደርሷል። 9 ግንበኞች እና 6 ረዳቶች ነበሩ።",
    expect: { workers: 15, progress: { B3000: 70 }, issues: [["material"]] },
  },
  {
    id: "am-6",
    group: "Amharic",
    language: "am",
    text: "አማካሪው የስላብ ብረት ስዕሉን ስላላጸደቀ የብረት ስራ መጀመር አልቻልንም። 4 አናጺዎች ፎርምወርኩን ቀጥለዋል፣ 55 በመቶ ደርሷል።",
    expect: { workers: 4, progress: { B2110: 55 }, issues: [["information", "delay"]] },
  },
  {
    id: "am-7",
    group: "Amharic",
    language: "am",
    text: "ዛሬ በዓል ስለሆነ ስራ አልነበረም።",
    expect: { workers: 0, progress: {} },
  },
  {
    id: "am-8",
    group: "Amharic",
    language: "am",
    text: "800 ብሎኬት ገብቷል። 25 ከረጢት ሲሚንቶ እና 900 ብሎኬት ተጠቅመናል። የብሎኬት ግንብ 55 በመቶ ደርሷል። 8 ግንበኞች እና 10 የቀን ሰራተኞች ነበሩ።",
    expect: { workers: 18, progress: { B3000: 55 }, used: { Cement: 25, "HCB blocks": 900 }, received: { "HCB blocks": 800 } },
  },

  // Amharic with English words, which is how many supervisors write
  {
    id: "mix-1",
    group: "Amharic and English mixed",
    language: "am",
    text: "ዛሬ formwork 1st floor 45% ደርሷል። 6 carpenters ነበሩ። 20 m3 aggregate ገብቷል።",
    expect: { workers: 6, progress: { B2110: 45 }, received: { Aggregate: 20 } },
  },
  {
    id: "mix-2",
    group: "Amharic and English mixed",
    language: "am",
    text: "Blockwork ground floor 75% ደርሷል, 10 masons ነበሩ, 30 bags cement ተጠቅመናል",
    expect: { workers: 10, progress: { B3000: 75 }, used: { Cement: 30 } },
  },
  {
    id: "mix-3",
    group: "Amharic and English mixed",
    language: "am",
    text: "electrical rough-in 40% ደርሷል። 3 electricians ነበሩ። ዝናብ ለ2 ሰዓት ስራ አስቁሟል።",
    expect: { workers: 3, progress: { B3010: 40 }, issues: [["weather"]] },
  },

  // Cases that trip people up too
  {
    id: "hard-1",
    group: "Hard cases",
    language: "en",
    text: "Columns floor 1 at 90%. Sorry, correction: the columns are fully finished. 7 steel fixers today.",
    expect: { workers: 7, progress: { B2100: 100 } },
  },
  {
    id: "hard-2",
    group: "Hard cases",
    language: "en",
    text: "Morning we had 5 masons. In the afternoon the same 5 masons plus 3 more joined. Blockwork 62%.",
    expect: { workers: 8, progress: { B3000: 62 } },
  },
  {
    id: "hard-3",
    group: "Hard cases",
    language: "en",
    text: "Painted the site office and the fence today, 2 painters.",
    expect: { workers: 2, progress: {} },
  },
  {
    id: "hard-4",
    group: "Hard cases",
    language: "en",
    text: "Found two workers on the slab edge without harness, stopped them and gave a toolbox talk. Formwork 50%. 6 carpenters.",
    expect: { workers: 6, progress: { B2110: 50 }, issues: [["safety"]] },
  },
  {
    id: "hard-5",
    group: "Hard cases",
    language: "en",
    text: "The concrete supplier did not show up, so the floor 1 slab pour is moved to tomorrow. 8 labourers were waiting most of the day.",
    expect: { workers: 8, progress: {}, issues: [["delay", "material", "other"]] },
  },
];

export interface QuoteCase {
  id: string;
  text: string;
  material: { name: string; unit: string; quantity: number };
  expect: { isQuote: boolean; unitPrice?: number; currency?: string; leadTimeDays?: number | null | [number, number]; reference?: string };
}

export const quoteCases: QuoteCase[] = [
  { id: "q-1", text: "4200 birr per bag, can deliver in 2 days", material: { name: "Cement", unit: "bag", quantity: 281 }, expect: { isQuote: true, unitPrice: 4200, currency: "ETB", leadTimeDays: 2 } },
  { id: "q-2", text: "1,150 ብር በከረጢት፣ በ3 ቀን እናደርሳለን", material: { name: "Cement", unit: "bag", quantity: 281 }, expect: { isQuote: true, unitPrice: 1150, currency: "ETB", leadTimeDays: 3 } },
  { id: "q-3", text: "Price is 118,000 per ton, delivery next week", material: { name: "Rebar", unit: "ton", quantity: 6 }, expect: { isQuote: true, unitPrice: 118000, currency: "ETB", leadTimeDays: [5, 7] } },
  { id: "q-4", text: "We can do 42 birr each, transport not included. 2 days.", material: { name: "HCB blocks", unit: "pcs", quantity: 1867 }, expect: { isQuote: true, unitPrice: 42, currency: "ETB", leadTimeDays: 2 } },
  { id: "q-5", text: "Sorry, we are out of stock this week.", material: { name: "Cement", unit: "bag", quantity: 281 }, expect: { isQuote: false } },
  { id: "q-6", text: "USD 950 per ton, 10 days to site", material: { name: "Rebar", unit: "ton", quantity: 6 }, expect: { isQuote: true, unitPrice: 950, currency: "USD", leadTimeDays: 10 } },
  { id: "q-7", text: "PR-1A2B3C4D: 2100 per m3, tomorrow", material: { name: "Aggregate", unit: "m3", quantity: 39 }, expect: { isQuote: true, unitPrice: 2100, currency: "ETB", leadTimeDays: 1, reference: "PR-1A2B3C4D" } },
  { id: "q-8", text: "ዋጋው በሜትር ኪዩብ 1900 ብር ነው። ነገ እናደርሳለን።", material: { name: "Sand", unit: "m3", quantity: 61 }, expect: { isQuote: true, unitPrice: 1900, currency: "ETB", leadTimeDays: 1 } },
  { id: "q-9", text: "Call me please, the price has changed.", material: { name: "Cement", unit: "bag", quantity: 281 }, expect: { isQuote: false } },
  { id: "q-10", text: "1150", material: { name: "Cement", unit: "bag", quantity: 281 }, expect: { isQuote: true, unitPrice: 1150, currency: "ETB", leadTimeDays: null } },
  { id: "q-11", text: "it is 43 birr per piece now with a delivery of 2 days", material: { name: "HCB blocks", unit: "pcs", quantity: 1867 }, expect: { isQuote: true, unitPrice: 43, currency: "ETB", leadTimeDays: 2 } },
  { id: "q-12", text: "2,050 br/m3 delivered to site within 48 hours", material: { name: "Sand", unit: "m3", quantity: 61 }, expect: { isQuote: true, unitPrice: 2050, currency: "ETB", leadTimeDays: 2 } },
];
