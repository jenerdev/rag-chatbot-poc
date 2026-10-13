import type { Metadata } from "next";
import { Icon, type IconName } from "@/components/icons";

// The root: a static landing page for the product (plan/landing.md, D-121).
// What it does and why it helps a resort; no pricing yet.
//
// Still true from plan.md Phase 7: it does NOT redirect to a tenant and does
// NOT list them. A redirect is a default tenant by another name, and a list
// of tenants is a customer list. Each tenant has its own address, /t/<slug>,
// and is reached by being given it. So the pictures here are MOCKUPS drawn
// in HTML and CSS with made-up content, never screenshots of a real
// tenant's chat, prices or guests.
//
// A Server Component with no data: it is rendered once, at build time.

/** The product's name, in one place: the working name until a real one is chosen. */
const PRODUCT = "StayDesk";

export const metadata: Metadata = {
  title: `${PRODUCT} · An AI front desk and booking system for resorts`,
  description:
    "Answer every guest question from your own information, day and night, and turn the answers into bookings your staff confirm.",
};

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  {
    icon: "chat",
    title: "Answers from your own information",
    text: "Paste your house rules, rooms and FAQs. The assistant answers only from them, shows where each answer came from, and says so when it does not know, instead of guessing.",
  },
  {
    icon: "messages",
    title: "Speaks the way your guests do",
    text: 'English, Taglish or Tagalog: guests are answered in the language they write in. "Bukas", "this weekend" and "for 3 guests" are understood.',
  },
  {
    icon: "calendar",
    title: "Live availability and prices",
    text: "Asked about a date, it checks your real calendar and quotes from your own rates: weekday, weekend, holiday and extra-guest fees included.",
  },
  {
    icon: "book",
    title: "A booking page of your own",
    text: "Guests pick their dates and rooms, see the price, and send a request with a reference number. Later they pay, upload a proof and ask for changes on one page.",
  },
  {
    icon: "bell",
    title: "Staff hear it the moment it arrives",
    text: "New requests, payment proofs and change requests reach your team in the app and on their phones, with a sound, so nothing waits until morning.",
  },
  {
    icon: "image",
    title: "Your brand, not ours",
    text: "Your logo, banner, colours and assistant name on every page guests see. Each property is its own workspace.",
  },
];

const ADVANTAGES: { title: string; text: string }[] = [
  {
    title: "Every inquiry answered, even at 2 AM",
    text: "Guests get an answer while they are still deciding, not the next day after they have booked elsewhere.",
  },
  {
    title: "Fewer repetitive messages",
    text: "Check-in times, parking, the pool, the deposit: the questions your staff answer ten times a day answer themselves.",
  },
  {
    title: "No double bookings",
    text: "A date cannot be confirmed twice. The system refuses it, however many staff or tabs are open.",
  },
  {
    title: "Prices that are never made up",
    text: "Rates come from your price list, holidays and promos included, never from the assistant’s imagination.",
  },
  {
    title: "Payments in one place",
    text: "Every proof of payment lands in one queue for your team to verify, with deadlines that expire unpaid requests on their own.",
  },
  {
    title: "Learn what guests really ask",
    text: "Every question it could not answer is listed for you, so each gap in your information is filled once.",
  },
];

const STEPS: { title: string; text: string }[] = [
  {
    title: "Add what you know",
    text: "Paste your documents, and set your rooms, rates, holidays and payment methods.",
  },
  {
    title: "Guests ask and book",
    text: "They chat with your assistant and send booking requests from your own page.",
  },
  {
    title: "Your team confirms",
    text: "Staff are notified, verify the payment, and confirm the stay in a click.",
  },
];

export default function Home() {
  return (
    <div className="landing">
      <header className="landing-nav">
        <a className="landing-logo" href="#top">
          <span className="landing-logo-mark" aria-hidden="true">
            <Icon name="chat" size={16} />
          </span>
          {PRODUCT}
        </a>
        <nav aria-label="Sections">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#why">Why it helps</a>
        </nav>
      </header>

      <main id="top">
        <section className="landing-hero">
          <div className="landing-hero-copy">
            <p className="landing-eyebrow">
              For resorts, inns and private villas
            </p>
            <h1>Your front desk, open around the clock.</h1>
            <p className="landing-lede">
              An AI assistant that answers your guests from your own
              information, and a booking system that turns those conversations
              into stays your team confirms.
            </p>
            <div className="landing-ctas">
              <a className="button primary" href="#features">
                See what it does
              </a>
              <a className="button" href="#how">
                How it works
              </a>
            </div>
            <ul className="landing-ticks">
              <li>
                <Icon name="check" size={16} /> English, Taglish and Tagalog
              </li>
              <li>
                <Icon name="check" size={16} /> Real availability and prices
              </li>
              <li>
                <Icon name="check" size={16} /> Your brand on every page
              </li>
            </ul>
          </div>

          {/* A mockup, not a screenshot: made-up content (see the top of this file). */}
          <div className="landing-mock" aria-hidden="true">
            <div className="mock-window">
              <div className="mock-bar">
                <span className="mock-avatar">L</span>
                <span>
                  <strong>Lia</strong>
                  <small>Your resort&rsquo;s assistant</small>
                </span>
              </div>
              <div className="mock-body">
                <div className="mock-bubble guest">
                  Is the Garden Room free on Saturday for 3 of us?
                </div>
                <div className="mock-bubble bot">
                  ✅ Yes, the Garden Room is open on Sat 14 Dec for 3 guests:{" "}
                  <strong>₱4,500.00</strong> (weekend rate).
                </div>
                <div className="mock-room">
                  <div className="mock-room-photo">
                    <span>
                      <Icon name="image" size={12} /> 4 photos
                    </span>
                  </div>
                  <div className="mock-room-body">
                    <strong>Garden Room</strong>
                    <span className="mock-chip">
                      Guests <b>up to 3</b>
                    </span>
                  </div>
                </div>
                <div className="mock-cta">
                  <Icon name="calendar" size={14} /> Book your stay
                </div>
              </div>
            </div>
            <div className="mock-toast">
              <span className="mock-toast-icon">
                <Icon name="bell" size={16} />
              </span>
              <span>
                <strong>New booking request</strong>
                <small>REF-7KQ4MX · 2 nights from Sat 14 Dec</small>
              </span>
            </div>
          </div>
        </section>

        <section id="features" className="landing-section">
          <h2>Everything a guest asks, and everything your team does next</h2>
          <p className="landing-section-lede">
            One assistant for your guests, one place for your staff.
          </p>
          <div className="landing-grid">
            {FEATURES.map((f) => (
              <article className="landing-feature" key={f.title}>
                <span className="landing-feature-icon" aria-hidden="true">
                  <Icon name={f.icon} size={20} />
                </span>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </article>
            ))}
          </div>
        </section>

        <div className="landing-band">
          <section id="how" className="landing-section">
            <h2>How it works</h2>
            <ol className="landing-steps">
              {STEPS.map((s, i) => (
                <li key={s.title}>
                  <span className="landing-step-number" aria-hidden="true">
                    {i + 1}
                  </span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <section id="why" className="landing-section">
          <h2>Why resorts use it</h2>
          <div className="landing-grid advantages">
            {ADVANTAGES.map((a) => (
              <div className="landing-advantage" key={a.title}>
                <Icon name="check" size={18} />
                <div>
                  <h3>{a.title}</h3>
                  <p>{a.text}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="landing-section landing-closing">
          <h2>Already have a workspace?</h2>
          <p>
            Open the address you were given: your guests&rsquo; chat is at{" "}
            <code>/t/your-name</code>, and your team signs in from there.
          </p>
        </section>
      </main>

      <footer className="landing-footer">
        <span>
          © {new Date().getFullYear()} {PRODUCT}
        </span>
        <span>An AI front desk and booking system for resorts.</span>
      </footer>
    </div>
  );
}
