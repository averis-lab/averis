import s from "./sections.module.css";
import { AverisMark } from "@/components/averis-mark";

/**
 * Every link here points at a route that exists — the product routes, the
 * anchors on this page, and the one official account. No placeholder social
 * icons: a row of greyed-out logos for accounts nobody runs says less than
 * nothing.
 */

/** The official account. Kept as a list so a second one costs one line. */
const SOCIALS = [
  {
    label: "@averislayer",
    href: "https://x.com/averislayer",
    name: "Averis on X",
    // The X mark, inlined: the page loads no external assets, and a remote
    // icon font for a single 13px glyph is a request and a layout shift.
    path: "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117Z",
  },
];
const COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Datanets", href: "/datanets" },
      { label: "Agents", href: "/agents" },
      { label: "Playground", href: "/playground" },
    ],
  },
  {
    heading: "Protocol",
    links: [
      { label: "Whitepaper", href: "/whitepaper" },
      { label: "Roadmap", href: "/roadmap" },
      { label: "How it works", href: "#how-it-works" },
      { label: "Example report", href: "#preview" },
      { label: "Why it is different", href: "#principles" },
      { label: "Comparison", href: "#compare" },
      { label: "Where this goes", href: "#progression" },
    ],
  },
  {
    heading: "Reference",
    links: [
      { label: "API and SDK", href: "#developers" },
      { label: "Domains", href: "#domains" },
      { label: "FAQ", href: "#faq" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className={s.footer}>
      <div className={s.footerTop}>
        <div className={s.footerBrand}>
          <a className={s.footerLogo} href="#top" aria-label="Averis">
            <AverisMark style={{ width: "var(--logo-mark, 22px)", height: "var(--logo-mark, 22px)" }} />
            <span>Averis</span>
          </a>
          <p className={s.footerLine}>
            The accountability layer between evidence and decisions. Specialist agents analyse
            independently; their claims are scored, weighted and merged with the evidence attached.
          </p>
          <span className={s.footerBadge}>
            <i aria-hidden="true" />
            Protocol MVP — settlement scaffolded, not enabled
          </span>
        </div>

        <nav className={s.footerNav} aria-label="Footer">
          {COLUMNS.map((column) => (
            <div key={column.heading} className={s.footerColumn}>
              <h2 className={s.footerHeading}>{column.heading}</h2>
              <ul>
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      {...("external" in link && link.external
                        ? { target: "_blank", rel: "noreferrer noopener" }
                        : {})}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>

      <div className={s.footerMark} aria-hidden="true">
        Averis
      </div>

      <div className={s.footerBottom}>
        <span>© {new Date().getFullYear()} Averis</span>
        <span className={s.footerNote}>Verify. Predict. Transact.</span>

        {SOCIALS.map((social) => (
          <a
            key={social.href}
            className={s.social}
            href={social.href}
            /* Icon-only, so the label is the only thing naming the destination. */
            aria-label={`${social.name} (${social.label})`}
            target="_blank"
            rel="noreferrer noopener"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={social.path} fill="currentColor" />
            </svg>
          </a>
        ))}
      </div>
    </footer>
  );
}
