// legal.ts — the privacy policy and terms TEXT (D-129, plan/legal.md § 3).
//
// EVERY WORD HERE IS A PLACEHOLDER for a lawyer to replace. It was written
// to say what the app actually does with personal data, so the lawyer has
// the facts in one place, not to be relied on as it stands; each page says
// so at the top (LEGAL_DRAFT_NOTICE).
//
// Pure: the pages fill these with the tenant's own values (its name, its
// privacy contact, its retention periods, its policy version) and render
// every string as a React child, never as HTML (CLAUDE.md § Conventions).
//
// The law is the Philippines' Data Privacy Act of 2012 (RA 10173). The
// resort is the personal information CONTROLLER for its guests; the
// platform is its PROCESSOR, under a data processing agreement (D-130).

/** The platform's own details: ONE place to change them (plan/legal.md § 0, decision 3). */
export const PLATFORM = {
  product: 'StayDesk',
  operator: "[Platform operator's registered name]",
  address: '[Registered business address]',
  privacyEmail: '[privacy@platform.example]',
  policyVersion: '1',
} as const;

export const LEGAL_DRAFT_NOTICE =
  'This text is a draft written to describe what this website does with personal data. It has not been reviewed by a lawyer yet and will be replaced.';

export interface LegalSection {
  heading: string;
  paragraphs: string[];
}
export interface LegalDocument {
  title: string;
  version: string;
  sections: LegalSection[];
}

/** What a tenant's pages state about it: its tenant_public() columns, and the proof limit from @rag/bookings. */
export interface TenantLegalFacts {
  businessName: string;
  assistantName: string;
  contactName: string | null;
  contactEmail: string | null;
  policyVersion: string;
  chatRetentionDays: number;
  guestRetentionDays: number;
  proofRetentionDays: number;
  /** does this tenant take bookings (and so guests' contact details and receipts)? */
  bookings: boolean;
  /** does this tenant's chat take spoken questions (D-134)? Absent: no. */
  voice?: boolean;
}

/** "365 days (about 1 year)": the number as stored, and a rounder reading of it (half years from a year up, else months). */
export function daysInWords(days: number): string {
  if (days >= 365) {
    const years = Math.round((days / 365) * 2) / 2;
    return `${days} days (about ${years} year${years === 1 ? '' : 's'})`;
  }
  const months = Math.max(1, Math.round(days / 30));
  return `${days} days (about ${months} month${months === 1 ? '' : 's'})`;
}

/** The way to reach the tenant about privacy: its named contact, or the resort itself. */
function contact(f: TenantLegalFacts): string {
  if (f.contactName && f.contactEmail) return `${f.contactName}, at ${f.contactEmail}`;
  if (f.contactEmail) return f.contactEmail;
  return `${f.businessName}, through the contact details on its booking page or its own website`;
}

export function tenantPrivacy(f: TenantLegalFacts): LegalDocument {
  const sections: LegalSection[] = [
    {
      heading: 'Who is responsible',
      paragraphs: [
        `${f.businessName} decides what personal information this website collects about you and why. Under the Data Privacy Act of 2012 (Republic Act No. 10173), ${f.businessName} is the personal information controller.`,
        `Its contact for privacy questions and requests (its Data Protection Officer) is ${contact(f)}.`,
        `The website is run for ${f.businessName} by ${PLATFORM.operator} (${PLATFORM.product}), which processes the information only on ${f.businessName}'s instructions, under a data processing agreement.`,
      ],
    },
    {
      heading: 'What is collected',
      paragraphs: [
        `When you chat with ${f.assistantName}, the assistant: every message you send and every answer, with the time.`,
        ...(f.voice
          ? ['When you speak to the assistant instead of typing: your recording is sent to OpenAI to be turned into text, and is not kept. The text is kept, as your message.']
          : []),
        ...(f.bookings
          ? [
              'When you send a booking request: your name, mobile number and email address, the dates, rooms and number of guests, any note you add, and the price quoted.',
              'When you send a proof of payment: the photo or PDF of your receipt (a photo is resized and its location data removed in your browser before it is sent), the amount, the date paid, the way you paid and any transaction number.',
              'When you ask to move or cancel a booking: the request and any reason you give.',
            ]
          : []),
        'Nothing is collected to follow you across other websites. Guests are given no cookies.',
      ],
    },
    {
      heading: 'Why it is used',
      paragraphs: [
        `To answer your questions about ${f.businessName} from its own information.`,
        ...(f.bookings
          ? [
              `To handle your booking request: to price it, to let ${f.businessName}'s staff confirm or decline it, to contact you about it, to check your payment, and to handle a change you ask for.`,
            ]
          : []),
        `${f.businessName}'s staff read chat conversations to see what guests ask and to improve the information the assistant answers from.`,
        f.bookings
          ? 'The basis for this is your consent, which you give when you send a booking request, and the steps needed to arrange the stay you asked for.'
          : "The basis for this is your consent, which you give by using the chat after reading this notice.",
      ],
    },
    {
      heading: 'Who it is shared with',
      paragraphs: [
        `${f.businessName}'s own staff, each seeing only what their role needs.`,
        `${PLATFORM.operator}, which runs the website, as ${f.businessName}'s processor.`,
        `OpenAI, which processes the text of your chat messages to write the assistant's answers${f.voice ? ', turns what you say into text and reads the answers aloud' : ''}. Do not type or say passwords, card numbers or other sensitive information in the chat.`,
        'The companies that host the website\'s database and files, under their own security obligations.',
        'Nobody else, unless the law requires it.',
      ],
    },
    {
      heading: 'How long it is kept',
      paragraphs: [
        `Chat conversations: ${daysInWords(f.chatRetentionDays)} after the last message, then deleted.`,
        ...(f.bookings
          ? [
              `Your name, mobile number, email address and notes on a booking: ${daysInWords(f.guestRetentionDays)} after check-out, then removed. The booking's dates, amounts and reference are kept for ${f.businessName}'s accounts.`,
              `Photos and PDFs of receipts: ${f.proofRetentionDays} days after your stay, then deleted.`,
            ]
          : []),
      ],
    },
    {
      heading: 'Your rights',
      paragraphs: [
        'You have the right to be informed, to access the information held about you, to have it corrected, to object, to have it erased or blocked, to receive a copy of it, and to be compensated for damage caused by its misuse.',
        `To use any of them, write to ${contact(f)}. You may also complain to the National Privacy Commission (privacy.gov.ph).`,
      ],
    },
    {
      heading: 'Changes',
      paragraphs: [`This is version ${f.policyVersion} of this policy. When it changes, the version changes${f.bookings ? ', and a new booking request asks you to agree again' : ''}.`],
    },
  ];
  return { title: `Privacy policy of ${f.businessName}`, version: f.policyVersion, sections };
}

export function tenantTerms(f: TenantLegalFacts): LegalDocument {
  const sections: LegalSection[] = [
    {
      heading: 'The assistant',
      paragraphs: [
        `${f.assistantName} answers from information ${f.businessName} has given it. It is an AI: it can be wrong or out of date, and it says so when it does not know. Check anything important, such as prices, dates and rules, with ${f.businessName} before you rely on it.`,
        'Use the chat for questions about the resort. Do not use it to send anything unlawful, abusive or that is not yours to share.',
      ],
    },
    ...(f.bookings
      ? [
          {
            heading: 'Booking requests',
            paragraphs: [
              `Sending a booking request does not book a date. ${f.businessName} confirms or declines it, and until it is confirmed the dates may go to someone else.`,
              `The price shown is the price for the request as sent. Payment, deposits, deadlines, cancellations and changes follow ${f.businessName}'s own terms, shown on the booking page and in Manage booking.`,
              'A proof of payment you send is checked by the resort\'s staff against their own account before a payment counts.',
            ],
          },
        ]
      : []),
    {
      heading: 'Your information',
      paragraphs: [`How your personal information is used is described in the privacy policy of ${f.businessName}.`],
    },
    {
      heading: 'The law',
      paragraphs: ['These terms are governed by the laws of the Republic of the Philippines.', `This is version ${f.policyVersion}.`],
    },
  ];
  return { title: `Terms of use of ${f.businessName}`, version: f.policyVersion, sections };
}

/** The platform's own pages (the landing page's footer). */
export function platformPrivacy(): LegalDocument {
  return {
    title: `${PLATFORM.product} privacy policy`,
    version: PLATFORM.policyVersion,
    sections: [
      {
        heading: 'Who we are',
        paragraphs: [`${PLATFORM.product} is run by ${PLATFORM.operator}, ${PLATFORM.address}. Privacy contact: ${PLATFORM.privacyEmail}.`],
      },
      {
        heading: 'Guests of a resort',
        paragraphs: [
          'Each resort that uses this website decides what it collects from its guests and why. Its own privacy policy is linked at the foot of its chat, booking and Manage booking pages. For those guests we are the resort\'s processor, under a data processing agreement.',
        ],
      },
      {
        heading: 'Staff accounts',
        paragraphs: [
          'A resort\'s staff sign in with an email address and a password. We keep the email address, which resort they belong to and their role, and a sign-in cookie that lasts up to 12 hours. It is needed for the sign-in to work, so no consent is asked for it.',
          'A staff member who turns on notifications on a device gives that device\'s push address, which goes to the browser maker\'s push service (Google, Apple or Mozilla) to deliver each notice. A notice names no guest.',
        ],
      },
      {
        heading: 'This page',
        paragraphs: ['This landing page sets no cookie and uses no analytics.'],
      },
      {
        heading: 'Your rights',
        paragraphs: [
          `Write to ${PLATFORM.privacyEmail} to be informed, to access, correct, object to, erase or block your information, or to receive a copy. You may also complain to the National Privacy Commission (privacy.gov.ph).`,
        ],
      },
    ],
  };
}

export function platformTerms(): LegalDocument {
  return {
    title: `${PLATFORM.product} terms of use`,
    version: PLATFORM.policyVersion,
    sections: [
      {
        heading: 'The service',
        paragraphs: [
          `${PLATFORM.product} gives resorts an AI assistant that answers from their own information, a booking page and the screens to run them. The terms between ${PLATFORM.operator} and each resort are in its written agreement, including the data processing agreement.`,
        ],
      },
      { heading: 'Guests', paragraphs: ['A guest\'s terms are the resort\'s own, linked at the foot of its pages.'] },
      { heading: 'The law', paragraphs: ['These terms are governed by the laws of the Republic of the Philippines.'] },
    ],
  };
}
