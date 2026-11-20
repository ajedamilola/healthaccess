import type { Metadata, Viewport } from "next";
import { Inter, Manrope } from "next/font/google";
import { themeScript, THEME_COLORS } from "@/lib/theme";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
// Display face for headings. Arc reads --font-geist for display type, so the brand face lands in Arc headings too.
const manrope = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-geist",
  display: "swap",
});
const manropeBrand = Manrope({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-manrope",
  display: "swap",
});

export const metadata: Metadata = {
  title: "HealthAccess: care within reach",
  description:
    "Find suitable care nearby and choose exactly which health information you share. Works on the web, SMS and USSD.",
};

export const viewport: Viewport = {
  themeColor: THEME_COLORS.light,
};

/*
 * Runs before first paint.
 * - data-motion: JS is on and motion is allowed, so CSS may hide elements that animate in. Without it, everything is visible.
 * - Preloader: only on "/", once per session, never under reduced motion. Failsafe lifts it after 2.5s.
 * sessionStorage holds only a "seen intro" flag (no health data).
 */
const preloadGate = `(function(){try{var d=document.documentElement;var rm=matchMedia('(prefers-reduced-motion: reduce)').matches;if(rm)return;d.setAttribute('data-motion','');var seen=false;try{seen=sessionStorage.getItem('ha-intro')==='1'}catch(e){}
if(location.pathname==='/'&&!seen){d.classList.add('ha-preload');setTimeout(function(){d.classList.add('ha-preload-done');d.setAttribute('data-intro','play')},2500)}else{d.setAttribute('data-intro','play')}}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${manrope.variable} ${manropeBrand.variable}`}
      data-theme="light"
      data-accent="green"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script dangerouslySetInnerHTML={{ __html: preloadGate }} />
      </head>
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[10000] focus:rounded-lg focus:bg-paper focus:px-4 focus:py-2 focus:text-ink"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
