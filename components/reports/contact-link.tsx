import { CONTACT_EMAIL } from "@/lib/contact";

/** The TurnitPlus contact address as a link (lib/contact.ts); nothing while none is configured. */
export function ContactLink() {
  if (!CONTACT_EMAIL) return null;
  return <a className="contact-link" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;
}
