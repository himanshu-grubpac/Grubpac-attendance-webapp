import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { getDefaultRoute } from '../config/nav.js';
import { BRANDING } from '../config/branding.js';
import {
  getBottomNavItems,
  getMoreNavItems,
  getVisibleNavItems,
  isDashboardPath,
  resolveBottomNavActive,
  resolveNavItemActive,
} from '../config/nav.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PageMetaProvider, usePageMetaContext } from '../context/PageMetaContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { useConfirmDialog } from '../hooks/useConfirmDialog.jsx';
import { useEscapeKey } from '../hooks/useEscapeKey.js';
import CompanyLogo from './CompanyLogo.jsx';
import NotificationBell from './NotificationBell.jsx';
import ThemeToggle from './ThemeToggle.jsx';

const SIDEBAR_STORAGE_KEY = 'attendance.sidebarCollapsed';

function getInitials(name) {
  if (!name) return '?';
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function readCollapsedPreference() {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function PageToolbar() {
  const { meta } = usePageMetaContext();
  const location = useLocation();
  const isDashboard = isDashboardPath(location.pathname);

  if (!meta?.title) return null;

  const isCompact = !isDashboard && Boolean(meta.subtitle) && !meta.actions;

  return (
    <header
      className={`page-toolbar${isDashboard ? ' page-toolbar--dashboard' : ''}${
        isCompact ? ' page-toolbar--compact' : ''
      }`}
    >
      <div className="page-toolbar__text">
        <h1 className="page-toolbar__title">{meta.title}</h1>
        {!isDashboard && meta.subtitle ? (
          <p className="page-toolbar__subtitle">{meta.subtitle}</p>
        ) : null}
      </div>
      {meta.actions ? <div className="page-toolbar__actions">{meta.actions}</div> : null}
    </header>
  );
}

/** Mobile-only account menu (desktop account lives in sidebar footer). */
function MobileAvatarMenu({
  user,
  profilePath,
  onLogout,
  loggingOut,
  canSwitchPortal,
  onSwitchPortal,
}) {
  const [open, setOpen] = useState(false);
  const { mode, setMode } = useTheme();
  const menuRef = useRef(null);
  const location = useLocation();
  const isDark = mode === 'dark';

  useEscapeKey(open, () => setOpen(false));

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return undefined;
    function handlePointer(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', handlePointer);
    return () => document.removeEventListener('pointerdown', handlePointer);
  }, [open]);

  return (
    <div className="avatar-menu" ref={menuRef}>
      <button
        type="button"
        className="user-chip user-chip--icon-only header-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account menu"
        disabled={loggingOut}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="user-chip__avatar" aria-hidden="true">
          {getInitials(user?.name)}
        </span>
        <span className="user-chip__name">{user?.name}</span>
      </button>
      {open ? (
        <div className="avatar-menu__panel" role="menu">
          <Link to={profilePath} className="avatar-menu__item" role="menuitem" onClick={() => setOpen(false)}>
            Account settings
          </Link>
          {canSwitchPortal ? (
            <button
              type="button"
              className="avatar-menu__item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSwitchPortal();
              }}
            >
              Switch portal
            </button>
          ) : null}
          <button
            type="button"
            className="avatar-menu__item"
            role="menuitem"
            onClick={() => {
              setMode(isDark ? 'light' : 'dark');
              setOpen(false);
            }}
          >
            {isDark ? 'Light theme' : 'Dark theme'}
          </button>
          <div className="avatar-menu__separator" role="separator" aria-hidden="true" />
          <button
            type="button"
            className="avatar-menu__item avatar-menu__item--danger"
            role="menuitem"
            disabled={loggingOut}
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            {loggingOut ? 'Signing out…' : 'Log out'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SidebarAccountFooter({
  user,
  profilePath,
  collapsed,
  onLogout,
  loggingOut,
  canSwitchPortal,
  onSwitchPortal,
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const location = useLocation();
  const displayName = (user?.name || 'Account').toUpperCase();

  useEscapeKey(open, () => setOpen(false));

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return undefined;
    function handlePointer(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', handlePointer);
    return () => document.removeEventListener('pointerdown', handlePointer);
  }, [open]);

  return (
    <div className={`sidebar-account${collapsed ? ' sidebar-account--collapsed' : ''}`} ref={menuRef}>
      {open ? (
        <div className="sidebar-account__popover" role="menu">
          <Link
            to={profilePath}
            className="sidebar-account__menu-item"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <span className="sidebar-account__menu-icon sidebar-account__menu-icon--avatar" aria-hidden="true">
              {getInitials(user?.name)}
            </span>
            <span>Account settings</span>
          </Link>
          {canSwitchPortal ? (
            <button
              type="button"
              className="sidebar-account__menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSwitchPortal();
              }}
            >
              <span className="sidebar-account__menu-icon" aria-hidden="true">
                ⇄
              </span>
              <span>Switch portal</span>
            </button>
          ) : null}
          <div className="sidebar-account__menu-sep" role="separator" aria-hidden="true" />
          <button
            type="button"
            className="sidebar-account__menu-item"
            role="menuitem"
            disabled={loggingOut}
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <span className="sidebar-account__menu-icon" aria-hidden="true">
              ↩
            </span>
            <span>{loggingOut ? 'Signing out…' : 'Log out'}</span>
          </button>
        </div>
      ) : null}

      <button
        type="button"
        className={`sidebar-account__trigger${open ? ' is-open' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account menu"
        disabled={loggingOut}
        title={collapsed ? user?.name : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="sidebar-account__avatar" aria-hidden="true">
          {getInitials(user?.name)}
        </span>
        {!collapsed ? (
          <>
            <span className="sidebar-account__name">{displayName}</span>
            <span className={`sidebar-account__chevron${open ? ' is-open' : ''}`} aria-hidden="true">
              ▾
            </span>
          </>
        ) : null}
      </button>
    </div>
  );
}

function MoreDrawer({ open, onClose, sections }) {
  useEscapeKey(open, onClose);

  if (!open) return null;

  return (
    <>
      <button type="button" className="more-drawer__backdrop" aria-label="Close menu" onClick={onClose} />
      <aside className="more-drawer" aria-label="Menu">
        <div className="more-drawer__header">
          <strong>Menu</strong>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <nav className="more-drawer__nav">
          {[...sections.entries()].map(([section, links]) => (
            <div key={section} className="more-drawer__group">
              <span className="more-drawer__section">{section}</span>
              {links.map((link) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  className={({ isActive }) => `more-drawer__link${isActive ? ' active' : ''}`}
                  onClick={onClose}
                >
                  <span aria-hidden="true">{link.icon}</span>
                  {link.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}

function BottomNav({ items, activeKey, onMore }) {
  return (
    <nav className="bottom-nav" aria-label="Primary">
      {items.map((item) => {
        const displayLabel = item.shortLabel ?? item.label;
        const ariaLabel = item.shortLabel ? item.label : undefined;

        if (item.key === 'more') {
          return (
            <button
              key={item.key}
              type="button"
              className={`bottom-nav__item${activeKey === 'more' ? ' active' : ''}`}
              aria-label="Open menu"
              aria-haspopup="dialog"
              onClick={onMore}
            >
              <span className="bottom-nav__icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="bottom-nav__label">{displayLabel}</span>
            </button>
          );
        }

        return (
          <NavLink
            key={item.key}
            to={item.to}
            end={item.key === 'home'}
            className={({ isActive }) =>
              `bottom-nav__item${activeKey === item.key || isActive ? ' active' : ''}`
            }
            aria-label={ariaLabel}
          >
            <span className="bottom-nav__icon" aria-hidden="true">
              {item.icon}
            </span>
            <span className="bottom-nav__label">{displayLabel}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

function AppLayoutShell() {
  const { user, logout, loggingOut, loginPortal, switchPortal, canSwitchPortal } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { meta } = usePageMetaContext();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const [collapsed, setCollapsed] = useState(readCollapsedPreference);
  const [moreOpen, setMoreOpen] = useState(false);

  const navItems = useMemo(() => getVisibleNavItems(user, loginPortal), [user, loginPortal]);
  const bottomNavItems = useMemo(() => getBottomNavItems(user, loginPortal), [user, loginPortal]);
  const moreNavItems = useMemo(() => getMoreNavItems(user, loginPortal), [user, loginPortal]);
  const isAdminPortal = loginPortal === 'admin';
  const profilePath = isAdminPortal ? '/admin/profile' : '/employee/profile';

  const sections = useMemo(() => {
    const grouped = new Map();
    for (const item of navItems) {
      const section = item.section ?? 'Navigation';
      if (!grouped.has(section)) grouped.set(section, []);
      grouped.get(section).push(item);
    }
    return grouped;
  }, [navItems]);

  const moreSections = useMemo(() => {
    const grouped = new Map();
    for (const item of moreNavItems) {
      const section = item.section ?? 'Navigation';
      if (!grouped.has(section)) grouped.set(section, []);
      grouped.get(section).push(item);
    }
    return grouped;
  }, [moreNavItems]);

  const bottomActiveKey = useMemo(
    () =>
      resolveBottomNavActive(
        location.pathname,
        bottomNavItems,
        moreNavItems.map((item) => item.to),
      ),
    [location.pathname, bottomNavItems, moreNavItems],
  );

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0');
    } catch {
      // Ignore storage failures.
    }
  }, [collapsed]);

  useEffect(() => {
    setMoreOpen(false);
  }, [location.pathname]);

  const handleLogout = useCallback(async () => {
    if (loggingOut) return;

    await requestConfirm({
      title: 'Log out?',
      message: 'You will need to sign in again to continue.',
      confirmLabel: 'Log out',
      busyLabel: 'Signing out…',
      variant: 'danger',
      onConfirm: async () => {
        await logout();
        navigate('/login', { replace: true });
      },
    });
  }, [loggingOut, logout, navigate, requestConfirm]);

  const handleSwitchPortal = useCallback(() => {
    const nextPortal = loginPortal === 'admin' ? 'employee' : 'admin';
    switchPortal(nextPortal);
    navigate(getDefaultRoute(user, nextPortal), { replace: true });
  }, [loginPortal, switchPortal, navigate, user]);

  return (
    <div className={`app-layout${collapsed ? ' app-layout--collapsed' : ''}`}>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <aside className="app-sidebar app-sidebar--desktop" aria-label="Sidebar">
        <div className="app-sidebar__toggle-bar">
          <button
            type="button"
            className="app-sidebar__toggle"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            aria-controls="app-sidebar-nav"
            aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
            title={collapsed ? 'Expand menu' : 'Collapse menu'}
          >
            <span className="app-sidebar__toggle-icon" aria-hidden="true">
              {collapsed ? '»' : '«'}
            </span>
            <span className="app-sidebar__toggle-label">
              {collapsed ? 'Expand menu' : 'Collapse menu'}
            </span>
          </button>
        </div>
        <div className="app-sidebar__brand">
          <CompanyLogo size={32} showText={!collapsed} />
          {!collapsed && (
            <span className="app-sidebar__portal-label">
              {isAdminPortal ? 'Admin' : 'Employee'}
            </span>
          )}
        </div>
        <nav className="app-nav" id="app-sidebar-nav" aria-label="Main navigation">
          {[...sections.entries()].map(([section, links]) => (
            <div key={section} className="app-nav__group">
              {!collapsed && <span className="app-nav__section">{section}</span>}
              {links.map((link) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={
                    link.to === '/employee/dashboard' ||
                    link.to === '/admin/dashboard' ||
                    link.to === '/admin/users/register' ||
                    link.to === '/admin/users/bulk-upload'
                  }
                  title={collapsed ? link.label : undefined}
                  className={({ isActive }) => {
                    const active = resolveNavItemActive(link.to, { isActive, location });
                    return `nav-link${active ? ' active' : ''}`;
                  }}
                >
                  <span className="nav-link__icon" aria-hidden="true">
                    {link.icon}
                  </span>
                  {!collapsed && <span className="nav-link__label">{link.label}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="app-sidebar__footer">
          <SidebarAccountFooter
            user={user}
            profilePath={profilePath}
            collapsed={collapsed}
            onLogout={handleLogout}
            loggingOut={loggingOut}
            canSwitchPortal={canSwitchPortal}
            onSwitchPortal={handleSwitchPortal}
          />
        </div>
      </aside>

      <header className="app-header">
        <div className="app-header__title-block">
          <span className="app-header__mobile-title">{meta?.title || BRANDING.companyName}</span>
          {!isDashboardPath(location.pathname) && meta?.subtitle ? (
            <span className="app-header__mobile-subtitle">{meta.subtitle}</span>
          ) : null}
        </div>
        <div className="app-header__actions" aria-busy={loggingOut || undefined}>
          <NotificationBell />
          <div className="app-header__desktop-utilities">
            <ThemeToggle />
          </div>
          <div className="app-header__mobile-utilities">
            <MobileAvatarMenu
              user={user}
              profilePath={profilePath}
              onLogout={handleLogout}
              loggingOut={loggingOut}
              canSwitchPortal={canSwitchPortal}
              onSwitchPortal={handleSwitchPortal}
            />
          </div>
        </div>
      </header>

      <main id="main-content" className="app-main" tabIndex={-1}>
        <div className="app-main__inner">
          <PageToolbar />
          <Outlet />
        </div>
      </main>

      <footer className="app-footer">
        © {new Date().getFullYear()} {BRANDING.companyName} ·{' '}
        <a href={BRANDING.websiteUrl} target="_blank" rel="noreferrer">
          {BRANDING.websiteUrl.replace('https://', '')}
        </a>
      </footer>

      <BottomNav
        items={bottomNavItems}
        activeKey={bottomActiveKey}
        onMore={() => setMoreOpen(true)}
      />

      <MoreDrawer
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        sections={moreSections}
      />

      {confirmDialog}
    </div>
  );
}

export default function AppLayout() {
  return (
    <PageMetaProvider>
      <AppLayoutShell />
    </PageMetaProvider>
  );
}
