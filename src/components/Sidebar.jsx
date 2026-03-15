import { Link, NavLink } from 'react-router-dom';
import { toInitCap } from '../utils/format';

export default function Sidebar({ admin = false, userProfile, user, onLogout, activeSection = 'matches', onSectionChange, isInsightApprover = false, isMobileOpen = false, onMobileClose }) {
  return (
    <>
      {onMobileClose && (
        <div
          className={`sidebar-overlay ${isMobileOpen ? 'open' : ''}`}
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}
      <aside className={`sidebar ${isMobileOpen ? 'mobile-open' : ''}`}>
        {onMobileClose && (
          <button
            type="button"
            className="sidebar-close"
            onClick={onMobileClose}
            aria-label="Close menu"
          >
            ×
          </button>
        )}
      <div className="sidebar-brand">
        <div className="sidebar-brand-row">
          <span className="sidebar-logo">🏏</span>
          <span className="sidebar-title">IPL Prediction</span>
        </div>
        <span className="sidebar-greeting">Hi, {toInitCap(userProfile?.username || userProfile?.email || user?.email || 'User')}</span>
      </div>

      <nav className="sidebar-nav">
        {admin ? (
          <>
            <Link to="/admin" className="sidebar-link active" onClick={onMobileClose}>
              <span className="sidebar-icon">⚙️</span>
              Admin Panel
            </Link>
            <Link to="/dashboard" className="sidebar-link" onClick={onMobileClose}>
              <span className="sidebar-icon">📊</span>
              Dashboard
            </Link>
            <Link to="/dashboard" state={{ section: 'leaderboard' }} className="sidebar-link" onClick={onMobileClose}>
              <span className="sidebar-icon">🏆</span>
              Leaderboard
            </Link>
            <button type="button" className={`sidebar-link ${activeSection === 'teams' ? 'active' : ''}`} onClick={() => { onSectionChange?.('teams'); onMobileClose?.(); }}>
              <span className="sidebar-icon">👥</span>
              Teams
            </button>
            <button type="button" className={`sidebar-link ${activeSection === 'rules' ? 'active' : ''}`} onClick={() => { onSectionChange?.('rules'); onMobileClose?.(); }}>
              <span className="sidebar-icon">📋</span>
              Rules
            </button>
            <button type="button" className={`sidebar-link ${activeSection === 'matches' ? 'active' : ''}`} onClick={() => { onSectionChange?.('matches'); onMobileClose?.(); }}>
              <span className="sidebar-icon">🏟️</span>
              Matches
            </button>
            <Link to="/insight-approval" className="sidebar-link" onClick={onMobileClose}>
              <span className="sidebar-icon">📝</span>
              Insight Approval
            </Link>
            <button type="button" className={`sidebar-link ${activeSection === 'passwordPolicy' ? 'active' : ''}`} onClick={() => { onSectionChange?.('passwordPolicy'); onMobileClose?.(); }}>
              <span className="sidebar-icon">🔐</span>
              Program Config
            </button>
            <button type="button" className={`sidebar-link ${activeSection === 'users' ? 'active' : ''}`} onClick={() => { onSectionChange?.('users'); onMobileClose?.(); }}>
              <span className="sidebar-icon">👤</span>
              Users
            </button>
          </>
        ) : (
          <>
            <button type="button" className={`sidebar-link ${activeSection === 'dashboard' ? 'active' : ''}`} onClick={() => { onSectionChange?.('dashboard'); onMobileClose?.(); }}>
              <span className="sidebar-icon">📊</span>
              Dashboard
            </button>
            <button type="button" className={`sidebar-link ${activeSection === 'teams' ? 'active' : ''}`} onClick={() => { onSectionChange?.('teams'); onMobileClose?.(); }}>
              <span className="sidebar-icon">👥</span>
              Teams
            </button>
            <button type="button" className={`sidebar-link ${activeSection === 'rules' ? 'active' : ''}`} onClick={() => { onSectionChange?.('rules'); onMobileClose?.(); }}>
              <span className="sidebar-icon">📋</span>
              Rules
            </button>
            <button type="button" className={`sidebar-link ${activeSection === 'matches' ? 'active' : ''}`} onClick={() => { onSectionChange?.('matches'); onMobileClose?.(); }}>
              <span className="sidebar-icon">🏟️</span>
              Matches
            </button>
            <button type="button" className={`sidebar-link ${activeSection === 'leaderboard' ? 'active' : ''}`} onClick={() => { onSectionChange?.('leaderboard'); onMobileClose?.(); }}>
              <span className="sidebar-icon">🏆</span>
              Leaderboard
            </button>
            <button type="button" className={`sidebar-link ${activeSection === 'account' ? 'active' : ''}`} onClick={() => { onSectionChange?.('account'); onMobileClose?.(); }}>
              <span className="sidebar-icon">👤</span>
              Account
            </button>
            {(userProfile?.isAdmin || isInsightApprover) && (
              <NavLink to="/insight-approval" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`} onClick={onMobileClose}>
                <span className="sidebar-icon">📝</span>
                Insight Approval
              </NavLink>
            )}
            {userProfile?.isAdmin && (
              <NavLink to="/admin" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`} onClick={onMobileClose}>
                <span className="sidebar-icon">⚙️</span>
                Admin Panel
              </NavLink>
            )}
          </>
        )}
      </nav>

      <div className="sidebar-footer">
        <button type="button" className="sidebar-link sidebar-logout" onClick={() => { onLogout(); onMobileClose?.(); }}>
          <span className="sidebar-icon">🚪</span>
          Logout
        </button>
      </div>
    </aside>
    </>
  );
}
