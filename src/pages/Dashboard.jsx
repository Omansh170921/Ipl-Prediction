import { useState, useEffect } from 'react';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { useLocation } from 'react-router-dom';
import CricketInsights from '../components/CricketInsights';
import { useAuth } from '../context/AuthContext';
import { collection, query, where, getDocs, getDoc, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase/config';
import Sidebar from '../components/Sidebar';
import { toInitCap } from '../utils/format';
import { calculateLeaderboard } from '../utils/points';

function formatMatchTime(time) {
  if (!time) return 'TBD';
  if (typeof time === 'string' && time.includes(':') && /^\d{1,2}:\d{2}$/.test(time)) {
    const [h, m] = time.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
  }
  return time;
}

function isPredictionEligible(match) {
  const threshold = match.thresholdTime || match.time || '23:59';
  const cutoff = new Date(match.date + 'T' + (threshold.length === 5 ? threshold : '23:59') + ':00');
  return new Date() < cutoff;
}

function getTeamCode(teamName, teams) {
  const t = teams.find(x => (x.name || '').toLowerCase() === (teamName || '').toLowerCase());
  return (t?.code || '').trim() || teamName || '';
}

function normalizePlayers(players) {
  if (!Array.isArray(players)) return [];
  return players.map(p => {
    if (typeof p === 'string') return { name: p, active: true, type: 'Batsman', role: 'player' };
    return { name: p?.name || '', active: p?.active !== false, type: p?.type || 'Batsman', role: p?.role || 'player' };
  });
}

export default function Dashboard() {
  const location = useLocation();
  const { user, userProfile, logout, surrenderAccount, getSurrenderDeadline, changePassword } = useAuth();
  const [matches, setMatches] = useState([]);
  const [allMatches, setAllMatches] = useState([]);
  const [rules, setRules] = useState([]);
  const [predictions, setPredictions] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [selectedTeam, setSelectedTeam] = useState('All');
  const [showCompleted, setShowCompleted] = useState(true);
  const [expandedTeamId, setExpandedTeamId] = useState(null);
  const [activeTab, setActiveTab] = useState('today');
  const [activeSection, setActiveSection] = useState('matches');
  const [teams, setTeams] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [insightLeaderboard, setInsightLeaderboard] = useState([]);
  const [leaderboardTab, setLeaderboardTab] = useState('main');
  const [pointRules, setPointRules] = useState({ notParticipatedPoints: 7, wrongPredictionPoints: 5 });
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardRefresh, setLeaderboardRefresh] = useState(0);
  const [matchesRefresh, setMatchesRefresh] = useState(0);
  const [surrenderDeadline, setSurrenderDeadline] = useState(null);
  const [surrenderLoading, setSurrenderLoading] = useState(false);
  const [surrenderError, setSurrenderError] = useState('');
  const [showSurrenderModal, setShowSurrenderModal] = useState(false);
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const [cpCurrentPassword, setCpCurrentPassword] = useState('');
  const [cpNewPassword, setCpNewPassword] = useState('');
  const [cpConfirmPassword, setCpConfirmPassword] = useState('');
  const [cpLoading, setCpLoading] = useState(false);
  const [cpMessage, setCpMessage] = useState('');
  const [expandedInsightMatchId, setExpandedInsightMatchId] = useState(null);
  const [cricketInsightsConfig, setCricketInsightsConfig] = useState({ enabled: true, maxQuestionsPerUserPerMatch: 1, maxQuestionsPerMatch: 5 });
  const [insightQuestionCount, setInsightQuestionCount] = useState({});
  const [insightPointsByMatch, setInsightPointsByMatch] = useState({});
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const today = new Date().toISOString().split('T')[0];

  useEffect(() => {
    const section = location.state?.section;
    if (section && ['dashboard', 'teams', 'rules', 'matches', 'leaderboard', 'account'].includes(section)) {
      setActiveSection(section);
    }
  }, [location.state?.section]);

  useEffect(() => {
    if (activeSection === 'account' && user) {
      getSurrenderDeadline().then(setSurrenderDeadline);
    }
  }, [activeSection, user]);

  useAutoDismiss(surrenderError, setSurrenderError);
  useAutoDismiss(cpMessage, setCpMessage);

  const getUniqueTeams = (list) => ['All', ...[...new Set(list.flatMap(m => [m.team1, m.team2].filter(Boolean)))].sort()];
  const teamOptionsToday = getUniqueTeams(matches);
  const teamOptionsHistory = getUniqueTeams(allMatches);

  const applyFilters = (list) => {
    let result = list;
    if (selectedTeam !== 'All') {
      result = result.filter(m =>
        (m.team1 || '').toLowerCase() === selectedTeam.toLowerCase() ||
        (m.team2 || '').toLowerCase() === selectedTeam.toLowerCase()
      );
    }
    return result;
  };

  const sortMatches = (list) => {
    return [...list].sort((a, b) => {
      const aCompleted = (a.status || '').toLowerCase() === 'completed';
      const bCompleted = (b.status || '').toLowerCase() === 'completed';
      if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;
      const cmpDate = (a.date || '').localeCompare(b.date || '');
      if (cmpDate !== 0) return cmpDate;
      const timeA = (a.time || '00:00').padEnd(5, '0');
      const timeB = (b.time || '00:00').padEnd(5, '0');
      return timeA.localeCompare(timeB);
    });
  };

  const filteredMatches = sortMatches(applyFilters(matches));
  const historyMatchesRaw = applyFilters(allMatches);
  const historyMatchesFiltered = showCompleted
    ? historyMatchesRaw
    : historyMatchesRaw.filter(m => (m.status || '').toLowerCase() !== 'completed');
  const historyMatches = sortMatches(historyMatchesFiltered);

  useEffect(() => {
    const fetchData = async () => {
      const matchesQuery = await getDocs(collection(db, 'matches'));
      const all = matchesQuery.docs.map(d => ({ id: d.id, ...d.data() }));
      const todayMatches = all.filter(m => m.date === today && (m.status === 'open' || !m.status));

      const teamsSnap = await getDocs(collection(db, 'teams'));
      setTeams(teamsSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const rulesSnap = await getDocs(collection(db, 'rules'));
      setRules(rulesSnap.docs
        .filter(d => d.id !== 'pointRules')
        .map(d => ({ id: d.id, ...d.data() })));

      const predSnap = await getDocs(
        query(collection(db, 'predictions'), where('userId', '==', user.uid))
      );
      const preds = {};
      predSnap.docs.forEach(d => { preds[d.data().matchId] = d.data().predictedWinner; });
      setPredictions(preds);

      try {
        const qSnap = await getDocs(
          query(collection(db, 'cricket_questions'), where('approved', '==', true))
        );
        const counts = {};
        const answeredQuestions = [];
        qSnap.docs.forEach(d => {
          const data = d.data();
          const mid = data.matchId;
          if (mid) counts[mid] = (counts[mid] || 0) + 1;
          if (data.correctAnswer != null) answeredQuestions.push({ id: d.id, matchId: mid, correctAnswer: data.correctAnswer });
        });
        setInsightQuestionCount(counts);
        const pointsByMatch = {};
        if (answeredQuestions.length > 0 && user?.uid) {
          try {
            const aSnap = await getDocs(
              query(collection(db, 'cricket_answers'), where('userId', '==', user.uid))
            );
            const myAnswers = {};
            aSnap.docs.forEach(d => { const x = d.data(); myAnswers[x.questionId] = x.answer; });
            answeredQuestions.forEach(q => {
              if (!q.matchId) return;
              const myAns = (myAnswers[q.questionId] || '').trim().toLowerCase();
              const correct = (q.correctAnswer || '').trim().toLowerCase();
              if (myAns && correct && myAns === correct) {
                pointsByMatch[q.matchId] = (pointsByMatch[q.matchId] || 0) + 1;
              }
            });
          } catch {
            /* ignore */
          }
        }
        setInsightPointsByMatch(pointsByMatch);
      } catch {
        setInsightQuestionCount({});
        setInsightPointsByMatch({});
      }
      try {
        const ciSnap = await getDoc(doc(db, 'settings', 'cricketInsights'));
        if (ciSnap.exists()) {
          const d = ciSnap.data();
          setCricketInsightsConfig({
            enabled: d.enabled !== false,
            maxQuestionsPerUserPerMatch: d.maxQuestionsPerUserPerMatch ?? 1,
            maxQuestionsPerMatch: d.maxQuestionsPerMatch ?? 5,
            insightApproverIds: Array.isArray(d.insightApproverIds) ? d.insightApproverIds : [],
          });
        }
      } catch {
        // use defaults
      }

      setAllMatches(all);
      setMatches(todayMatches);
      setLoading(false);
    };
    if (user) fetchData();
  }, [user, today, matchesRefresh]);

  useEffect(() => {
    const fetchLeaderboard = async () => {
      if (activeSection !== 'leaderboard') return;
      setLeaderboardLoading(true);
      try {
        const [usersSnap, matchesSnap, predsSnap, ptSnap] = await Promise.all([
          getDocs(collection(db, 'users')).catch(() => ({ docs: [] })),
          getDocs(collection(db, 'matches')),
          getDocs(collection(db, 'predictions')),
          getDoc(doc(db, 'rules', 'pointRules')),
        ]);
        const allUsers = (usersSnap?.docs || []).map(d => ({ id: d.id, ...d.data() }));
        const users = allUsers.filter(u => !u.isAdmin && u.isAdmin !== 'true');
        const allMatches = matchesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const completedMatches = allMatches.filter(m =>
          (m.status || '').toLowerCase() === 'completed' && (m.winner || '').trim()
        );
        const predsByMatch = {};
        predsSnap.docs.forEach(d => {
          const { matchId, userId, predictedWinner } = d.data();
          if (!predsByMatch[matchId]) predsByMatch[matchId] = [];
          predsByMatch[matchId].push({ userId, predictedWinner });
        });
        const rules = ptSnap.exists() ? ptSnap.data() : { notParticipatedPoints: 7, wrongPredictionPoints: 5 };
        setPointRules(rules);
        const totals = calculateLeaderboard(completedMatches, users, predsByMatch, rules);
        const ranked = users.map(u => ({
          ...u,
          points: totals[u.id] ?? 0,
        })).sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
        setLeaderboard(ranked);
        const insightRanked = [...users]
          .map(u => ({ ...u, insightPoints: u.insightPoints ?? 0 }))
          .sort((a, b) => (b.insightPoints ?? 0) - (a.insightPoints ?? 0));
        setInsightLeaderboard(insightRanked);
      } catch (err) {
        console.error('Leaderboard fetch error:', err);
      }
      setLeaderboardLoading(false);
    };
    fetchLeaderboard();
  }, [user, activeSection, leaderboardRefresh]);

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setCpMessage('');
    if (cpNewPassword !== cpConfirmPassword) {
      setCpMessage('New passwords do not match');
      return;
    }
    if (cpNewPassword.length < 6) {
      setCpMessage('New password must be at least 6 characters');
      return;
    }
    if (!cpCurrentPassword) {
      setCpMessage('Current password is required');
      return;
    }
    setCpLoading(true);
    try {
      await changePassword(cpCurrentPassword, cpNewPassword);
      setCpMessage('Password changed successfully.');
      setCpCurrentPassword('');
      setCpNewPassword('');
      setCpConfirmPassword('');
      setTimeout(() => {
        setShowChangePasswordModal(false);
        setCpMessage('');
      }, 1500);
    } catch (err) {
      setCpMessage(err?.message?.includes('limit') ? err.message : 'Invalid credential please validate.');
    }
    setCpLoading(false);
  };

  const handleSurrenderAccount = async () => {
    setSurrenderError('');
    setSurrenderLoading(true);
    try {
      await surrenderAccount();
      setShowSurrenderModal(false);
    } catch (err) {
      setSurrenderError(err.message || 'Failed to surrender account');
    } finally {
      setSurrenderLoading(false);
    }
  };

  const handleSavePrediction = async (matchId, predictedWinner, match) => {
    if (match && !isPredictionEligible(match)) {
      alert('Prediction closed. You had to predict before the cutoff time.');
      return;
    }
    setSaving(matchId);
    try {
      await setDoc(doc(db, 'predictions', `${user.uid}_${matchId}`), {
        userId: user.uid,
        matchId,
        predictedWinner,
        username: userProfile?.username,
        createdAt: new Date().toISOString(),
      });
      setPredictions(prev => ({ ...prev, [matchId]: predictedWinner }));
    } catch (err) {
      alert(err.message);
    }
    setSaving(null);
  };

  return (
    <div className="app-layout">
      <Sidebar
        admin={false}
        userProfile={userProfile}
        user={user}
        onLogout={logout}
        activeSection={activeSection}
        onSectionChange={setActiveSection}
        isInsightApprover={(cricketInsightsConfig.insightApproverIds || []).includes(user?.uid)}
        isMobileOpen={mobileMenuOpen}
        onMobileClose={() => setMobileMenuOpen(false)}
      />

      <main className="app-main">
        <header className="dashboard-header">
          <button type="button" className="hamburger-btn" onClick={() => setMobileMenuOpen(true)} aria-label="Open menu">
            ☰
          </button>
          <h1>🏏 IPL Prediction Portal</h1>
        </header>

        <div className="dashboard-content">
        {activeSection === 'dashboard' && (
          <section className="rules-section">
            <h2>Overview</h2>
            {rules.length > 0 && (
              <>
                <h3>Rules</h3>
                <ul>
                  {rules.slice(0, 3).map((r, i) => (
                    <li key={r.id || i}>{r.key ? <><strong>{r.key}:</strong> {r.content}</> : r.content}</li>
                  ))}
                  {rules.length > 3 && <li className="muted">... and {rules.length - 3} more</li>}
                </ul>
              </>
            )}
            <p className="muted">Use the sidebar to view Teams, Rules, or Matches in detail.</p>
          </section>
        )}

        {activeSection === 'teams' && (
          <section className="rules-section">
            <h2>Teams</h2>
            {loading ? (
              <p>Loading...</p>
            ) : teams.length === 0 ? (
              <p className="no-matches">No teams added yet.</p>
            ) : (
              <ul className="teams-list">
                {teams.map(t => {
                  const allPlayers = normalizePlayers(t.players || []);
                  const activePlayers = allPlayers.filter(p => p.active);
                  return (
                    <li key={t.id} className="team-row-wrapper">
                      <button
                        type="button"
                        className="team-name-btn"
                        onClick={() => setExpandedTeamId(expandedTeamId === t.id ? null : t.id)}
                      >
                        {t.name}{t.code ? ` (${t.code})` : ''}
                        <span className="team-count"> — {activePlayers.length} active players</span>
                      </button>
                      {expandedTeamId === t.id && (
                        <div className="team-players-detail">
                          <strong>Playing: {activePlayers.length} players</strong>
                          {activePlayers.length > 0 ? (
                            <ul className="team-players-list">
                              {activePlayers.map((p, i) => (
                                <li key={i} className="player-active">
                                  {p.name}
                                  {p.role === 'captain' && <span className="role-badge role-captain">C</span>}
                                  {p.role === 'viceCaptain' && <span className="role-badge role-vice-captain">VC</span>}
                                  <span className="player-type-tag">{p.type || 'Batsman'}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="muted">No active players for this match.</p>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {activeSection === 'rules' && (
          <section className="rules-section">
            <h2>Rules</h2>
            {loading ? (
              <p>Loading...</p>
            ) : rules.length === 0 ? (
              <p className="no-matches">No rules added yet.</p>
            ) : (
              <ul>
                {rules.map((r, i) => (
                  <li key={r.id || i}>{r.key ? <><strong>{r.key}:</strong> {r.content}</> : r.content}</li>
                ))}
              </ul>
            )}
          </section>
        )}

        {activeSection === 'leaderboard' && (
          <section className="rules-section leaderboard-section">
            <h2>🏆 Leaderboard</h2>
            <div className="filter-group" style={{ marginBottom: '1rem' }}>
              <button
                type="button"
                className={`filter-tag ${leaderboardTab === 'main' ? 'active' : ''}`}
                onClick={() => setLeaderboardTab('main')}
              >
                Main
              </button>
              <button
                type="button"
                className={`filter-tag ${leaderboardTab === 'insights' ? 'active' : ''}`}
                onClick={() => setLeaderboardTab('insights')}
              >
                Insights
              </button>
            </div>
            {leaderboardTab === 'main' && (
              <>
                <p className="muted">Points: Not participated = -{pointRules.notParticipatedPoints ?? 7}, Wrong prediction = -{pointRules.wrongPredictionPoints ?? 5}. Winners share the pool equally.</p>
                {leaderboardLoading ? (
                  <p>Loading leaderboard...</p>
                ) : leaderboard.length === 0 ? (
                  <p className="no-matches">No users yet or no completed matches with winners.</p>
                ) : (
                  <>
                    {user && (() => {
                      const myRank = leaderboard.findIndex(u => u.id === user.uid) + 1;
                      const myPoints = leaderboard.find(u => u.id === user.uid)?.points ?? 0;
                      return (
                        <p className="leaderboard-summary">
                          Your rank: <strong>{myRank > 0 ? `#${myRank}` : '—'}</strong>
                          {' · '}Your total points: <strong className={myPoints >= 0 ? 'points-positive' : 'points-negative'}>{myPoints}</strong>
                        </p>
                      );
                    })()}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setLeaderboardRefresh(r => r + 1)}
                      title="Refresh leaderboard"
                      style={{ marginBottom: '1rem' }}
                    >
                      🔄 Refresh
                    </button>
                    <div className="leaderboard-table">
                      <div className="leaderboard-header">
                        <span>Rank</span>
                        <span>User</span>
                        <span>Points</span>
                      </div>
                      {leaderboard.map((u, i) => (
                        <div key={u.id} className={`leaderboard-row ${u.id === user?.uid ? 'current-user' : ''}`}>
                          <span>{i + 1}</span>
                          <span>{toInitCap(u.username || u.email || 'User')}</span>
                          <span className={u.points >= 0 ? 'points-positive' : 'points-negative'}>{u.points}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            {leaderboardTab === 'insights' && (
              <>
                <p className="muted">Points from correct answers in Cricket Insights questions.</p>
                {leaderboardLoading ? (
                  <p>Loading leaderboard...</p>
                ) : insightLeaderboard.length === 0 ? (
                  <p className="no-matches">No insight points yet. Answer Cricket Insights questions correctly to earn points!</p>
                ) : (
                  <>
                    {user && (() => {
                      const myRank = insightLeaderboard.findIndex(u => u.id === user.uid) + 1;
                      const myInsightPoints = insightLeaderboard.find(u => u.id === user.uid)?.insightPoints ?? 0;
                      return (
                        <p className="leaderboard-summary">
                          Your rank: <strong>{myRank > 0 ? `#${myRank}` : '—'}</strong>
                          {' · '}Your insight points: <strong className="points-positive">{myInsightPoints}</strong>
                        </p>
                      );
                    })()}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setLeaderboardRefresh(r => r + 1)}
                      title="Refresh leaderboard"
                      style={{ marginBottom: '1rem' }}
                    >
                      🔄 Refresh
                    </button>
                    <div className="leaderboard-table">
                      <div className="leaderboard-header">
                        <span>Rank</span>
                        <span>User</span>
                        <span>Insight Points</span>
                      </div>
                      {insightLeaderboard.map((u, i) => (
                        <div key={u.id} className={`leaderboard-row ${u.id === user?.uid ? 'current-user' : ''}`}>
                          <span>{i + 1}</span>
                          <span>{toInitCap(u.username || u.email || 'User')}</span>
                          <span className="points-positive">{u.insightPoints ?? 0}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        )}

        {activeSection === 'account' && !userProfile?.isAdmin && (
        <section className="rules-section account-section">
          <h2>Account</h2>
          <div className="account-details">
            <h3>Your Details</h3>
            <dl className="account-details-list">
              <dt>Username</dt>
              <dd>{toInitCap(userProfile?.username || '—')}</dd>
              <dt>Email</dt>
              <dd>{user?.email || '—'}</dd>
            </dl>
          </div>
          <div className="account-actions account-actions-row">
            <button type="button" className="btn btn-primary" onClick={logout}>
              Logout
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { setShowChangePasswordModal(true); setCpMessage(''); }}
            >
              Change Password
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => { setShowSurrenderModal(true); setSurrenderError(''); }}
            >
              Surrender Account
            </button>
          </div>
        </section>
        )}

        {activeSection === 'account' && userProfile?.isAdmin && (
        <section className="rules-section account-section">
          <h2>Account</h2>
          <div className="account-details">
            <h3>Your Details</h3>
            <dl className="account-details-list">
              <dt>Username</dt>
              <dd>{toInitCap(userProfile?.username || '—')}</dd>
              <dt>Email</dt>
              <dd>{user?.email || '—'}</dd>
              <dt>Role</dt>
              <dd>Admin</dd>
            </dl>
          </div>
          <div className="account-actions account-actions-row">
            <button type="button" className="btn btn-primary" onClick={logout}>
              Logout
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { setShowChangePasswordModal(true); setCpMessage(''); }}
            >
              Change Password
            </button>
          </div>
          <p className="muted" style={{ marginTop: '1rem' }}>Admin accounts cannot surrender. Use the Admin Panel to manage users.</p>
        </section>
        )}

        {activeSection === 'matches' && (
        <section className="matches-section">
          <div className="dashboard-tabs">
            <button
              type="button"
              className={`dashboard-tab ${activeTab === 'today' ? 'active' : ''}`}
              onClick={() => setActiveTab('today')}
            >
              Today's Matches
            </button>
            <button
              type="button"
              className={`dashboard-tab ${activeTab === 'history' ? 'active' : ''}`}
              onClick={() => setActiveTab('history')}
            >
              All Matches History
            </button>
            <button
              type="button"
              className={`dashboard-tab dashboard-tab-action ${showCompleted ? 'active' : ''}`}
              onClick={() => setShowCompleted(prev => !prev)}
            >
              {showCompleted ? 'Hide completed' : 'Show completed'}
            </button>
          </div>

          {activeTab === 'today' && (
            <>
          <h2>Today's Matches ({today})</h2>
          {matches.length > 0 && (
            <>
              <div className="filter-group">
                <span className="filter-label">Team:</span>
                <div className="filter-tags">
                  {teamOptionsToday.map(team => (
                    <button
                      key={team}
                      type="button"
                      className={`filter-tag ${selectedTeam === team ? 'active' : ''}`}
                      onClick={() => setSelectedTeam(team)}
                    >
                      {team === 'All' ? team : getTeamCode(team, teams)}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          {loading ? (
            <p>Loading matches...</p>
          ) : filteredMatches.length === 0 ? (
            <p className="no-matches">
              {matches.length === 0
                ? 'No matches scheduled for today. Check back later!'
                : `No matches match your filters. Try a different team.`}
            </p>
          ) : (
            <div className="matches-grid">
              {filteredMatches.map(match => (
                <div key={match.id} className="match-card">
                  <div className="match-info">
                    <span className="match-slot">{formatMatchTime(match.time || match.slot)}</span>
                    {(match.thresholdTime || match.time) && (
                      <span className="match-threshold">Predict before {formatMatchTime(match.thresholdTime || match.time)}</span>
                    )}
                    <h3>
                      <span className={selectedTeam !== 'All' && (match.team1 || '').toLowerCase() === selectedTeam.toLowerCase() ? 'team-highlight' : ''}>{getTeamCode(match.team1, teams)}</span>
                      {' vs '}
                      <span className={selectedTeam !== 'All' && (match.team2 || '').toLowerCase() === selectedTeam.toLowerCase() ? 'team-highlight' : ''}>{getTeamCode(match.team2, teams)}</span>
                    </h3>
                  </div>
                  <div className="match-prediction">
                        {!isPredictionEligible(match) ? (
                      <>
                        <p className="prediction-closed">Prediction closed. Cutoff was {formatMatchTime(match.thresholdTime || match.time)} on {match.date}.</p>
                        {match.winner && <p className="match-winner-badge">🏆 Winner: {getTeamCode(match.winner, teams)}</p>}
                        <div className="match-points-row">
                          {match.pointResults && match.pointResults[user?.uid] != null && (
                            <p className="match-points-badge">Your points: <strong className={match.pointResults[user.uid] >= 0 ? 'points-positive' : 'points-negative'}>{match.pointResults[user.uid]}</strong></p>
                          )}
                          {cricketInsightsConfig.enabled && (insightPointsByMatch[match.id] || 0) > 0 && (
                            <p className="match-points-badge match-insight-points">Insight points: <strong className="points-positive">+{insightPointsByMatch[match.id]}</strong></p>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                    <label>Predict Winner:</label>
                    <div className="prediction-row">
                      <select
                        value={predictions[match.id] || ''}
                        onChange={(e) => setPredictions(prev => ({ ...prev, [match.id]: e.target.value }))}
                        disabled={saving === match.id}
                      >
                        <option value="">Select...</option>
                        <option value={match.team1}>{getTeamCode(match.team1, teams)}</option>
                        <option value={match.team2}>{getTeamCode(match.team2, teams)}</option>
                      </select>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => predictions[match.id] && handleSavePrediction(match.id, predictions[match.id], match)}
                        disabled={!predictions[match.id] || saving === match.id}
                      >
                        {saving === match.id ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                    </>
                    )}
                  </div>
                  {predictions[match.id] && (
                    <p className="saved-badge">✓ Saved: {getTeamCode(predictions[match.id], teams)}</p>
                  )}
                  {cricketInsightsConfig.enabled && (
                    <>
                      <div className="match-actions-row">
                        <button
                          type="button"
                          className={`btn btn-sm btn-insight ${expandedInsightMatchId === match.id ? 'active' : ''}`}
                          onClick={() => setExpandedInsightMatchId(expandedInsightMatchId === match.id ? null : match.id)}
                          title="Ask or answer Cricket Insights questions"
                        >
                          <span className="btn-insight-count">{insightQuestionCount[match.id] || 0}</span>
                          💡 Cricket Insights
                        </button>
                      </div>
                      {expandedInsightMatchId === match.id && (
                        <div className="match-insights">
                          <CricketInsights matchId={match.id} config={cricketInsightsConfig} />
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
            </>
          )}

          {activeTab === 'history' && (
            <>
              <h2>All Matches History</h2>
              {allMatches.length > 0 && (
                <>
                  <div className="filter-group">
                    <span className="filter-label">Team:</span>
                    <div className="filter-tags">
                      {teamOptionsHistory.map(team => (
                        <button
                          key={team}
                          type="button"
                          className={`filter-tag ${selectedTeam === team ? 'active' : ''}`}
                          onClick={() => setSelectedTeam(team)}
                        >
                          {team === 'All' ? team : getTeamCode(team, teams)}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
              {loading ? (
                <p>Loading matches...</p>
              ) : historyMatches.length === 0 ? (
                <p className="no-matches">
                  {allMatches.length === 0 ? 'No matches yet. Check back later!' : 'No matches match your filters. Try a different team.'}
                </p>
              ) : (
                <div className="matches-grid history-grid">
                  {historyMatches.map(match => (
                    <div key={match.id} className="match-card match-card-history">
                      <div className="match-info">
                        <div className="match-meta-row">
                          <span className="match-date">{match.date}</span>
                          <span className="match-slot">{formatMatchTime(match.time || match.slot)}</span>
                          <span className={`match-status-badge ${match.status || 'open'}`}>{match.status || 'open'}</span>
                        </div>
                        <h3>
                          <span className={selectedTeam !== 'All' && (match.team1 || '').toLowerCase() === selectedTeam.toLowerCase() ? 'team-highlight' : ''}>{getTeamCode(match.team1, teams)}</span>
                          {' vs '}
                          <span className={selectedTeam !== 'All' && (match.team2 || '').toLowerCase() === selectedTeam.toLowerCase() ? 'team-highlight' : ''}>{getTeamCode(match.team2, teams)}</span>
                        </h3>
                        {match.winner && <p className="match-winner-badge">🏆 Winner: {getTeamCode(match.winner, teams)}</p>}
                      </div>
                      {predictions[match.id] && (
                        <p className="saved-badge">✓ Your prediction: {getTeamCode(predictions[match.id], teams)}</p>
                      )}
                      <div className="match-points-row">
                        {match.pointResults && match.pointResults[user?.uid] != null && (
                          <p className="match-points-badge">
                            Your points: <strong className={match.pointResults[user.uid] >= 0 ? 'points-positive' : 'points-negative'}>{match.pointResults[user.uid]}</strong>
                          </p>
                        )}
                        {cricketInsightsConfig.enabled && (insightPointsByMatch[match.id] || 0) > 0 && (
                          <p className="match-points-badge match-insight-points">Insight points: <strong className="points-positive">+{insightPointsByMatch[match.id]}</strong></p>
                        )}
                      </div>
                      {cricketInsightsConfig.enabled && (
                        <>
                          <div className="match-actions-row">
                            <button
                              type="button"
                              className={`btn btn-sm btn-insight ${expandedInsightMatchId === match.id ? 'active' : ''}`}
                              onClick={() => setExpandedInsightMatchId(expandedInsightMatchId === match.id ? null : match.id)}
                              title="Ask or answer Cricket Insights questions"
                            >
                              <span className="btn-insight-count">{insightQuestionCount[match.id] || 0}</span>
                              💡 Cricket Insights
                            </button>
                          </div>
                          {expandedInsightMatchId === match.id && (
                            <div className="match-insights">
                              <CricketInsights matchId={match.id} config={cricketInsightsConfig} />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
        )}
        </div>
      </main>

      {showChangePasswordModal && (
        <div className="modal-overlay" onClick={() => !cpLoading && setShowChangePasswordModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Update Password</h3>
              <button type="button" className="modal-close" onClick={() => !cpLoading && setShowChangePasswordModal(false)} aria-label="Close">&times;</button>
            </div>
            {cpMessage && (
              <div className={`alert ${cpMessage.includes('success') ? 'alert-success' : 'alert-error'}`}>
                {cpMessage}
              </div>
            )}
            <form onSubmit={handleChangePassword} className="account-form">
              <div className="form-group">
                <label>Current Password</label>
                <input
                  type="password"
                  value={cpCurrentPassword}
                  onChange={(e) => setCpCurrentPassword(e.target.value)}
                  placeholder="Enter current password"
                  required
                />
              </div>
              <div className="form-group">
                <label>New Password</label>
                <input
                  type="password"
                  value={cpNewPassword}
                  onChange={(e) => setCpNewPassword(e.target.value)}
                  placeholder="Min 6 characters"
                  minLength={6}
                  required
                />
              </div>
              <div className="form-group">
                <label>Confirm New Password</label>
                <input
                  type="password"
                  value={cpConfirmPassword}
                  onChange={(e) => setCpConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  minLength={6}
                  required
                />
              </div>
              <div className="modal-actions">
                <button type="submit" className="btn btn-primary" disabled={cpLoading}>
                  {cpLoading ? 'Changing...' : 'Update Password'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => { setShowChangePasswordModal(false); setCpMessage(''); }} disabled={cpLoading}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showSurrenderModal && (
        <div className="modal-overlay" onClick={() => !surrenderLoading && setShowSurrenderModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Surrender Account</h3>
              <button type="button" className="modal-close" onClick={() => !surrenderLoading && setShowSurrenderModal(false)} aria-label="Close">&times;</button>
            </div>
            <div className="surrender-policy">
              <p>Permanently delete all your details (profile, predictions) and revoke app access. You will not be able to login again. This action cannot be undone.</p>
              {surrenderDeadline && (
                <p>You can surrender until <strong>{surrenderDeadline}</strong>. Today is {today}.</p>
              )}
            </div>
            {surrenderError && <div className="alert alert-error">{surrenderError}</div>}
            <div className="surrender-confirm">
              {surrenderDeadline && today > surrenderDeadline ? (
                <p className="surrender-period-ended">The surrender period has ended ({surrenderDeadline}). You can no longer surrender your account.</p>
              ) : (
                <>
                  <p className="surrender-confirm-question">Do you really want to permanently delete your account?</p>
                  <div className="surrender-confirm-buttons">
                    <button type="button" className="btn btn-primary" onClick={handleSurrenderAccount} disabled={surrenderLoading}>
                      {surrenderLoading ? 'Deleting...' : 'Yes'}
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={() => setShowSurrenderModal(false)} disabled={surrenderLoading}>
                      No
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
