import Link from "next/link";

export const metadata = {
  title: "Terms of Service — VIDELINK",
  description: "Terms and acceptable use guidelines for VIDELINK video transfers.",
};

export default function TermsPage() {
  return (
    <div className="min-h-[calc(100vh-4rem)] py-16">
      <div className="vl-container max-w-3xl space-y-8">
        <div>
          <Link
            href="/"
            className="text-sm text-[var(--vl-text-secondary)] hover:text-[var(--vl-accent)] transition-colors"
          >
            ← Back to Home
          </Link>
          <h1 className="text-3xl font-bold mt-4 mb-2" style={{ color: "var(--vl-text-primary)" }}>
            Terms of Service
          </h1>
          <p className="text-sm" style={{ color: "var(--vl-text-tertiary)" }}>
            VIDELINK — Service terms and acceptable use
          </p>
        </div>

        <div className="vl-card p-6 sm:p-8 space-y-6 text-sm leading-relaxed" style={{ color: "var(--vl-text-secondary)" }}>
          <section className="space-y-2">
            <h2 className="text-base font-semibold" style={{ color: "var(--vl-text-primary)" }}>
              1. Acceptable Use
            </h2>
            <p>
              You are responsible for the content you share through VIDELINK. Do not upload or
              transmit unlawful content, malware, or files you do not have permission to share.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold" style={{ color: "var(--vl-text-primary)" }}>
              2. Temporary Delivery
            </h2>
            <p>
              VIDELINK is designed for temporary video delivery rather than permanent archiving.
              Always retain a backup copy of important files, as transfers expire automatically.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold" style={{ color: "var(--vl-text-primary)" }}>
              3. Service Availability
            </h2>
            <p>
              Peer-to-peer transfers require both sender and recipient sessions to remain open until
              completion. Download limits and expiration windows are enforced automatically.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
