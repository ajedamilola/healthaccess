"use client";

import { Drawer, DrawerClose, DrawerContent } from "@/components/arc/drawer/drawer";
import { Button } from "@/components/arc/button/button";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { UserMenu } from "@/components/arc/user-menu/user-menu";
import { useLogout, useSession } from "@/api/hooks/session";
import { ApiError } from "@/api/errors";
import {
  ClipboardList,
  FileText,
  History,
  LayoutDashboard,
  Menu,
  MessageSquare,
  Pill,
  Share2,
  ShieldAlert,
  Stethoscope,
  UserRound, KeyRound } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { initialsAvatar } from "./avatar";
import { useTheme } from "./useTheme";
import styles from "./app-shell.module.css";

const navItems = [
  { href: "/app", label: "Overview", icon: LayoutDashboard },
  { href: "/app/assistant", label: "Assistant", icon: MessageSquare },
  { href: "/app/medications", label: "Medications", icon: Pill },
  { href: "/app/record", label: "My record", icon: FileText },
  { href: "/app/emergency-summary", label: "Emergency summary", icon: ShieldAlert },
  { href: "/app/access", label: "Sharing and access", icon: Share2 },
  { href: "/lookup", label: "Open a code", icon: KeyRound },
  { href: "/app/access-log", label: "Access log", icon: History },
  { href: "/app/channels", label: "Channels", icon: ClipboardList },
  { href: "/app/profile", label: "Profile", icon: UserRound },
];

function isActive(pathname: string, href: string) {
  if (href === "/app") return pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? "";
  return (
    <ul className={styles.navList}>
      {navItems.map((item) => {
        const Icon = item.icon;
        const active = isActive(pathname, item.href);
        const link = (
          <Link
            href={item.href}
            className={active ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
          >
            <Icon aria-hidden="true" size={18} strokeWidth={1.75} />
            <span>{item.label}</span>
          </Link>
        );
        return (
          <li key={item.href}>
            {onNavigate ? (
              <DrawerClose asChild onClick={onNavigate}>
                {link}
              </DrawerClose>
            ) : (
              link
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { theme, setTheme } = useTheme();
  const { data: session, error, isLoading } = useSession();
  const logout = useLogout();
  const router = useRouter();
  const pathname = usePathname() ?? "/app";
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (error instanceof ApiError && (error.status === 401 || error.code === "unauthorized")) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [error, pathname, router]);

  async function signOut() {
    try {
      await logout.mutateAsync();
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  const name = session?.account.display_name ?? session?.account.email ?? "Your account";
  const email = session?.account.email ?? "";
  const current = navItems.find((item) => isActive(pathname, item.href));
  const isPractitioner = session?.roles.includes("PRACTITIONER") ?? false;

  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>

      <aside className={styles.sidebar}>
        <Link className={styles.brand} href="/app">
          <span aria-hidden="true" className={styles.mark}>
            +
          </span>
          HealthAccess
        </Link>

        <nav aria-label="Main">
          <NavLinks />
        </nav>

        {isPractitioner ? (
          <div className={styles.practitioner}>
            <p className={styles.sidebarLabel}>Practitioner</p>
            <Link className={styles.navLink} href="/practitioner/lookup">
              <Stethoscope aria-hidden="true" size={18} strokeWidth={1.75} />
              <span>Open a patient code</span>
            </Link>
          </div>
        ) : null}

        <p className={styles.sidebarNote}>You choose what is shared, and for how long.</p>
      </aside>

      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <div className={styles.topbarStart}>
            <div className={styles.mobileMenu}>
              <Drawer open={navOpen} onOpenChange={setNavOpen}>
                <Button variant="ghost" size="sm" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
                  <Menu aria-hidden="true" size={20} />
                </Button>
                <DrawerContent title="Menu" description="Go to a section." side="left">
                  <nav aria-label="Mobile">
                    <NavLinks onNavigate={() => setNavOpen(false)} />
                  </nav>
                </DrawerContent>
              </Drawer>
            </div>
            {current ? (
              <p className={styles.pageTitle}>
                <span className={styles.pageIcon} aria-hidden="true">
                  <current.icon size={16} strokeWidth={1.75} />
                </span>
                {current.label}
              </p>
            ) : null}
            <Link className={styles.mobileBrand} href="/app">
              HealthAccess
            </Link>
          </div>

          <div className={styles.account}>
            {isLoading ? (
              <div className={styles.accountSkeleton}>
                <Skeleton lines={1} label="Loading account" />
              </div>
            ) : session ? (
              <UserMenu
                user={{ name, email, avatarSrc: initialsAvatar(name) }}
                showName
                theme={theme}
                onThemeChange={setTheme}
                items={[
                  {
                    label: "Profile",
                    icon: <UserRound aria-hidden="true" size={16} />,
                    onSelect: () => router.push("/app/profile"),
                  },
                ]}
                onSignOut={signOut}
              />
            ) : null}
          </div>
        </header>

        <main id="main" className={styles.main}>
          {children}
        </main>
      </div>
    </div>
  );
}
