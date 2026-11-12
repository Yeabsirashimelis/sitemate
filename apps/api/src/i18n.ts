/**
 * Fixed bot messages in English and Amharic. Anything the agents write is
 * generated in the user's language; these are the few messages that are not.
 */

type Language = "en" | "am";

const messages = {
  welcome: {
    en: (name: string, company: string) =>
      `Welcome ${name}. Your Telegram is now linked to ${company} on SiteMate. I will message you here.`,
    am: (name: string, company: string) =>
      `እንኳን ደህና መጡ ${name}። የቴሌግራም መለያዎ ከ${company} ጋር በSiteMate ተገናኝቷል። መልዕክቶችን እዚህ እልክልዎታለሁ።`,
  },
  inviteInvalid: {
    en: () => "That code is not valid or has expired. Please ask your project manager for a new one.",
    am: () => "ይህ ኮድ ትክክል አይደለም ወይም ጊዜው አልፏል። እባክዎ ከፕሮጀክት ማኔጀርዎ አዲስ ኮድ ይጠይቁ።",
  },
  unknownUser: {
    en: () =>
      "Hello. This is the SiteMate assistant. To start, send the code your project manager gave you, like this: /start ABCD2345",
    am: () => "ሰላም። ይህ የSiteMate ረዳት ነው። ለመጀመር ፕሮጀክት ማኔጀርዎ የሰጥዎትን ኮድ እንዲህ ይላኩ፦ /start ABCD2345",
  },
  received: {
    en: () => "Got it, thank you.",
    am: () => "ደርሶኛል፣ አመሰግናለሁ።",
  },
  notOnProject: {
    en: () => "You are not on any active project yet. Please ask your project manager to add you.",
    am: () => "እስካሁን በማንኛውም ንቁ ፕሮጀክት ላይ አልተመደቡም። እባክዎ ፕሮጀክት ማኔጀርዎ እንዲጨምሩዎት ይጠይቁ።",
  },
  somethingWrong: {
    en: () => "Sorry, something went wrong on my side. I have noted it, please try again in a few minutes.",
    am: () => "ይቅርታ፣ በእኔ በኩል ችግር ተፈጥሯል። እባክዎ ከጥቂት ደቂቃዎች በኋላ እንደገና ይሞክሩ።",
  },
  checkIn: {
    en: (name: string, project: string) =>
      `Good evening ${name}. Please send today's update for ${project}: what work was done, how many workers by trade, materials received or used, any problems, and a few photos. A voice note is fine.`,
    am: (name: string, project: string) =>
      `እንደምን አመሹ ${name}። እባክዎ የዛሬውን የ${project} ሪፖርት ይላኩ፦ የተሰራው ስራ፣ የሰራተኞች ብዛት በሙያ፣ የገቡ ወይም የተጠቀሙባቸው ማቴሪያሎች፣ ያጋጠሙ ችግሮች እና ጥቂት ፎቶዎች። የድምፅ መልዕክትም ይቻላል።`,
  },
  logSaved: {
    en: (summary: string) => `Thank you. Today's log is saved.\n\n${summary}`,
    am: (_summary: string) => "አመሰግናለሁ። የዛሬው ሪፖርት ተመዝግቧል።",
  },
  logFailed: {
    en: () => "Thank you. I could not process your update automatically, so I have passed it to your project manager.",
    am: () => "አመሰግናለሁ። ሪፖርትዎን በራሴ ማስኬድ አልቻልኩም፣ ስለዚህ ለፕሮጀክት ማኔጀርዎ አስተላልፌዋለሁ።",
  },
} as const;

export type MessageKey = keyof typeof messages;

export function t<K extends MessageKey>(
  key: K,
  language: Language,
  ...args: Parameters<(typeof messages)[K]["en"]>
): string {
  const template = messages[key][language] as (...a: typeof args) => string;
  return template(...args);
}
