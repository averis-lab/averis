import s from "./sections.module.css";
import { AverisMark } from "@/components/averis-mark";

/**
 * Every link here points at a route that exists — the product routes, the
 * anchors on this page, and Reppo's own site. No placeholder social icons.
 */
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
    ],
  },
  {
    heading: "Reference",
    links: [
      { label: "API and SDK", href: "#developers" },
      { label: "Domains", href: "#domains" },
      { label: "FAQ", href: "#faq" },
      { label: "Reppo", href: "https://reppo.ai", external: true },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className={s.footer}>
      <div className={s.footerTop}>
        <div className={s.footerBrand}>
          <a className={s.footerLogo} href="#top" aria-label="Averis.ai">
            <AverisMark style={{ width: "var(--logo-mark, 22px)", height: "var(--logo-mark, 22px)" }} />
            <span>
              Averis<span className={s.footerLogoSuffix}>.ai</span>
            </span>
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

      <div className={s.footerBottom}>
        <span>© {new Date().getFullYear()} Averis</span>
        <span className={s.footerNote}>
          Reppo is external infrastructure, not part of this protocol.
        </span>
      </div>
    </footer>
  );
}
