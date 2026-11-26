import Link from "next/link";

export const metadata = {
  title: "Privacy Policy — VIDELINK",
  description: "How VIDELINK handles your video transfers, metadata, and security.",
};

export default function PrivacyPage() {
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
            Privacy Policy
          </h1>
          <p className="text-sm" style={{ color: "var(--vl-text-tertiary)" }}>
            VIDELINK — Private, temporary video transfers
          </p>
        </div>

        <div className="vl-card p-6 sm:p-8 space-y-6 text-sm leading-relaxed" style={{ color: "var(--vl-text-secondary)" }}>
          <section className="space-y-2">
            <h2 className="text-base font-semibold" style={{ color: "var(--vl-text-primary)" }}>
              1. Transfer Data &amp; Files
            </h2>
            <p>
              In Direct P2P Stream mode, video data streams directly between the sender&apos;s and
              recipient&apos;s browsers over WebRTC without storing video payloads on our servers. Only
              temporary signaling metadata and transfer session details are stored until expiration.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold" style={{ color: "var(--vl-text-primary)" }}>
              2. Security &amp; Access Controls
            </h2>
            <p>
              Transfer codes are stored as HMAC-SHA256 hashes for lookup, optional passwords are
              hashed with bcrypt, and temporary audit metadata uses truncated one-way IP hashes for
              abuse prevention.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold" style={{ color: "var(--vl-text-primary)" }}>
              3. Retention &amp; Expiration
            </h2>
            <p>
              Transfers automatically expire after the duration selected by the sender (1 hour, 24
              hours, or 7 days), after which stored files and access authorization become unavailable.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
