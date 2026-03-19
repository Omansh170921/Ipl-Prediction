import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { useLocation } from 'react-router-dom';
import CricketInsights from '../components/CricketInsights';
import { useAuth } from '../context/AuthContext';
import { collection, query, where, getDocs, getDoc, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase/config';
import Sidebar from '../components/Sidebar';
import { toInitCap } from '../utils/format';
import { calculateLeaderboard, to2Decimals } from '../utils/points';

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

function canUserPredict(userProfile, programConfig) {
  const matchStartDate = (programConfig?.matchStartDate || '').trim();
  if (!matchStartDate) return true;
  const createdAtDate = (userProfile?.createdAt || '').toString().split('T')[0];
  if (!createdAtDate) return true;
  if (createdAtDate < matchStartDate) return true;
  return userProfile?.predictionApproved === true;
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
  const [savedPredictions, setSavedPredictions] = useState({});
  const [savedMatchIds, setSavedMatchIds] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [selectedMatchFilter, setSelectedMatchFilter] = useState('All');
  const [selectedHistoryMatchFilter, setSelectedHistoryMatchFilter] = useState('All');
  const [selectedTeamFilter, setSelectedTeamFilter] = useState('All');
  const [expandedTeamId, setExpandedTeamId] = useState(null);
  const [activeTab, setActiveTab] = useState('today');
  const [activeSection, setActiveSection] = useState('dashboard');
  const [matchFilterDate, setMatchFilterDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [teams, setTeams] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [insightLeaderboard, setInsightLeaderboard] = useState([]);
  const [leaderboardTab, setLeaderboardTab] = useState('main');
  const [leaderboardDate, setLeaderboardDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [leaderboardRawData, setLeaderboardRawData] = useState(null);
  const [pointRules, setPointRules] = useState({ notParticipatedPoints: 7, wrongPredictionPoints: 5 });
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardRefresh, setLeaderboardRefresh] = useState(0);
  const [userPointHistoryModal, setUserPointHistoryModal] = useState(null);
  const [showWinnerLoser, setShowWinnerLoser] = useState(true);
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
  const [participantsModal, setParticipantsModal] = useState(null);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [showPointsHistoryModal, setShowPointsHistoryModal] = useState(false);
  const [showWinsLossesModal, setShowWinsLossesModal] = useState(false);
  const [showParticipatedModal, setShowParticipatedModal] = useState(false);
  const [showTodayMatchesModal, setShowTodayMatchesModal] = useState(false);
  const [cricketInsightsConfig, setCricketInsightsConfig] = useState({ enabled: true, maxQuestionsPerUserPerMatch: 1, maxQuestionsPerMatch: 5 });
  const [programConfig, setProgramConfig] = useState({ matchStartDate: '' });
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

  const getMatchNum = (m) => parseInt(String(m.matchNumber || m.id || '0'), 10) || 0;
  const todayMatches = allMatches.filter(m => m.date === today);
  const dateFilteredMatches = matchFilterDate
    ? allMatches.filter(m => m.date === matchFilterDate)
    : allMatches;
  const matchOptionsToday = [...todayMatches]
    .sort((a, b) => getMatchNum(a) - getMatchNum(b))
    .map((m, i) => ({
      id: m.id,
      label: `${m.matchNumber || (i + 1)} - ${getTeamCode(m.team1, teams)} vs ${getTeamCode(m.team2, teams)}`,
    }));
  const historyMatchList = matchFilterDate ? dateFilteredMatches : allMatches;
  const matchOptionsHistory = [...historyMatchList]
    .sort((a, b) => {
      const numA = getMatchNum(a);
      const numB = getMatchNum(b);
      if (numA !== numB) return numA - numB;
      return (a.date || '').localeCompare(b.date || '');
    })
    .map((m, i) => ({
      id: m.id,
      label: `${m.matchNumber || (i + 1)} - ${getTeamCode(m.team1, teams)} vs ${getTeamCode(m.team2, teams)}`,
      date: m.date,
    }));

  const applyFiltersToday = (list) => {
    if (selectedMatchFilter === 'All') return list;
    return list.filter(m => m.id === selectedMatchFilter);
  };

  const applyFiltersHistory = (list) => {
    let result = list;
    if (selectedHistoryMatchFilter !== 'All') {
      result = result.filter(m => m.id === selectedHistoryMatchFilter);
    }
    if (selectedTeamFilter !== 'All' && selectedTeamFilter) {
      const teamNorm = (selectedTeamFilter || '').toLowerCase().trim();
      result = result.filter(m => {
        const t1 = (m.team1 || '').toLowerCase().trim();
        const t2 = (m.team2 || '').toLowerCase().trim();
        return t1 === teamNorm || t2 === teamNorm;
      });
    }
    return result;
  };

  const sortMatches = (list) => {
    return [...list].sort((a, b) => {
      const aIsToday = (a.date || '') === today;
      const bIsToday = (b.date || '') === today;
      if (aIsToday && !bIsToday) return -1;
      if (!aIsToday && bIsToday) return 1;
      const matchNumA = parseInt(String(a.matchNumber || a.id || '0'), 10) || 0;
      const matchNumB = parseInt(String(b.matchNumber || b.id || '0'), 10) || 0;
      if (matchNumA !== matchNumB) return matchNumA - matchNumB;
      const cmpDate = (a.date || '').localeCompare(b.date || '');
      if (cmpDate !== 0) return cmpDate;
      const timeA = (a.time || '00:00').padEnd(5, '0');
      const timeB = (b.time || '00:00').padEnd(5, '0');
      return timeA.localeCompare(timeB);
    });
  };

  const filteredMatches = sortMatches(applyFiltersToday(todayMatches));
  const historyMatchesRaw = applyFiltersHistory(matchFilterDate ? dateFilteredMatches : allMatches);
  const maxMatchId = allMatches.length === 0 ? 0 : Math.max(
    ...allMatches.map(m => parseInt(String(m.matchNumber || '0'), 10)).filter(n => !isNaN(n)),
    allMatches.length
  );
  const historyMatchesFiltered = historyMatchesRaw;
  const historyMatches = sortMatches(historyMatchesFiltered);

  useEffect(() => {
    if (selectedMatchFilter !== 'All' && !todayMatches.some(m => m.id === selectedMatchFilter)) {
      setSelectedMatchFilter('All');
    }
  }, [todayMatches, selectedMatchFilter]);

  useEffect(() => {
    const list = matchFilterDate ? dateFilteredMatches : allMatches;
    if (selectedHistoryMatchFilter !== 'All' && !list.some(m => m.id === selectedHistoryMatchFilter)) {
      setSelectedHistoryMatchFilter('All');
    }
  }, [matchFilterDate, dateFilteredMatches, allMatches, selectedHistoryMatchFilter]);

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
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));

      const predSnap = await getDocs(
        query(collection(db, 'predictions'), where('userId', '==', user.uid))
      );
      const preds = {};
      const savedPreds = {};
      const savedIds = new Set();
      predSnap.docs.forEach(d => {
        const data = d.data();
        const mid = data.matchId ?? data.matchID;
        if (mid != null) {
          const key = String(mid);
          preds[key] = data.predictedWinner;
          savedPreds[key] = data.predictedWinner;
          savedIds.add(key);
        }
      });
      setPredictions(preds);
      setSavedPredictions(savedPreds);
      setSavedMatchIds(savedIds);

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
        all.forEach(m => {
          const stored = m.insightPointResults?.[user?.uid];
          if (stored != null && stored !== undefined) {
            pointsByMatch[m.id] = Number(stored);
          }
        });
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
      try {
        const progSnap = await getDoc(doc(db, 'settings', 'programConfig'));
        if (progSnap.exists()) {
          const d = progSnap.data();
          setProgramConfig({ matchStartDate: d.matchStartDate || '' });
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
      if (activeSection !== 'leaderboard' && activeSection !== 'dashboard') return;
      setLeaderboardLoading(true);
      try {
        const [usersSnap, matchesSnap, predsSnap, ptSnap, progSnap] = await Promise.all([
          getDocs(collection(db, 'users')).catch(() => ({ docs: [] })),
          getDocs(collection(db, 'matches')),
          getDocs(collection(db, 'predictions')),
          getDoc(doc(db, 'rules', 'pointRules')),
          getDoc(doc(db, 'settings', 'programConfig')).catch(() => null),
        ]);
        const allUsers = (usersSnap?.docs || []).map(d => ({ id: d.id, ...d.data() }));
        const users = allUsers.filter(u => !u.isAdmin && u.isAdmin !== 'true');
        const allMatches = matchesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const predsByMatch = {};
        predsSnap.docs.forEach(d => {
          const { matchId, userId, predictedWinner } = d.data();
          if (!predsByMatch[matchId]) predsByMatch[matchId] = [];
          predsByMatch[matchId].push({ userId, predictedWinner });
        });
        const rules = ptSnap.exists() ? ptSnap.data() : { notParticipatedPoints: 7, wrongPredictionPoints: 5 };
        const prog = progSnap?.exists() ? progSnap.data() : {};
        const programConfig = {
          matchStartDate: prog.matchStartDate || '',
          loserPercent: Math.max(0, Math.min(50, parseInt(prog.loserPercent, 10) || 25)),
        };
        setPointRules(rules);
        setLeaderboardRawData({ users, allMatches, predsByMatch, rules, programConfig });
      } catch (err) {
        console.error('Leaderboard fetch error:', err);
      }
      setLeaderboardLoading(false);
    };
    fetchLeaderboard();
  }, [user, activeSection, leaderboardRefresh]);

  useEffect(() => {
    if (!leaderboardRawData) return;
    const { users, allMatches, predsByMatch, rules, programConfig } = leaderboardRawData;
    const matchStartDate = (programConfig?.matchStartDate || '').trim();
    let completedMatches = allMatches.filter(m =>
      (m.status || '').toLowerCase() === 'completed' && (m.winner || '').trim()
    );
    if (leaderboardDate) {
      completedMatches = completedMatches.filter(m => (m.date || '') <= leaderboardDate);
    }
    completedMatches.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const totals = calculateLeaderboard(completedMatches, users, predsByMatch, rules);
    let sortedByPoints = users.map(u => ({
      ...u,
      points: totals[u.id] ?? 0,
    })).sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
    // Late users (added on/after match start date): assign bottom last user's points as single total, not match-wise
    if (matchStartDate && sortedByPoints.length > 0) {
      const bottomPoints = sortedByPoints[sortedByPoints.length - 1].points ?? 0;
      sortedByPoints = sortedByPoints.map(u => {
        const createdAtDate = (u.createdAt || '').toString().split('T')[0];
        const isLateUser = createdAtDate && createdAtDate >= matchStartDate;
        return isLateUser ? { ...u, points: bottomPoints, isLateUser: true } : { ...u, isLateUser: false };
      }).sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
    }
    let rank = 1;
    const ranked = sortedByPoints.map((u, i) => {
      if (i > 0 && (sortedByPoints[i - 1].points ?? 0) > (u.points ?? 0)) rank += 1;
      return { ...u, rank };
    });
    setLeaderboard(ranked);
    let insightMatches = allMatches;
    if (leaderboardDate) {
      insightMatches = insightMatches.filter(m => (m.date || '') <= leaderboardDate);
    }
    const insightTotals = {};
    users.forEach(u => { insightTotals[u.id] = 0; });
    insightMatches.forEach(m => {
      const ir = m.insightPointResults;
      if (ir && typeof ir === 'object') {
        Object.entries(ir).forEach(([uid, pts]) => {
          insightTotals[uid] = (insightTotals[uid] || 0) + Number(pts || 0);
        });
      }
    });
    const sortedByInsight = [...users]
      .map(u => ({ ...u, insightPoints: insightTotals[u.id] ?? 0 }))
      .sort((a, b) => (b.insightPoints ?? 0) - (a.insightPoints ?? 0));
    rank = 1;
    const insightRanked = sortedByInsight.map((u, i) => {
      if (i > 0 && (sortedByInsight[i - 1].insightPoints ?? 0) > (u.insightPoints ?? 0)) rank += 1;
      return { ...u, rank };
    });
    setInsightLeaderboard(insightRanked);
  }, [leaderboardRawData, leaderboardDate]);

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
    if (!canUserPredict(userProfile, programConfig)) {
      alert('You are awaiting admin approval to predict matches. Please contact the admin.');
      return;
    }
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
      const key = String(matchId);
      setPredictions(prev => ({ ...prev, [key]: predictedWinner }));
      setSavedPredictions(prev => ({ ...prev, [key]: predictedWinner }));
      setSavedMatchIds(prev => new Set([...prev, key]));
    } catch (err) {
      alert(err.message);
    }
    setSaving(null);
  };

  const openParticipantsModal = async (match) => {
    if (!match?.id) return;
    setParticipantsModal({ match, participants: null });
    setParticipantsLoading(true);
    try {
      const [matchSnap, predsSnap, usersSnap] = await Promise.all([
        getDoc(doc(db, 'matches', match.id)),
        getDocs(query(collection(db, 'predictions'), where('matchId', '==', match.id))),
        getDocs(collection(db, 'users')).catch(() => ({ docs: [] })),
      ]);
      const matchData = matchSnap?.exists?.() ? { id: matchSnap.id, ...matchSnap.data() } : match;
      const predMap = new Map();
      predsSnap.docs.forEach(d => {
        const data = d.data();
        const userId = data.userId ?? data.uid ?? d.id?.split('_')?.[0];
        predMap.set(userId, data.predictedWinner);
      });
      const allUsersList = (usersSnap?.docs || []).filter(d => {
        const u = d.data();
        return !u.isAdmin && u.isAdmin !== 'true';
      });
      const participants = allUsersList.map(d => {
        const userId = d.id;
        const u = d.data();
        const displayName = u?.username ? toInitCap(String(u.username).replace(/_/g, ' ')) : (u?.email || userId || '—');
        const predictedWinner = predMap.get(userId) ?? null;
        return { userId, predictedWinner, displayName };
      }).sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
      setParticipantsModal(prev => prev && prev.match?.id === match.id ? { ...prev, match: matchData, participants } : prev);
    } catch (err) {
      console.error('Fetch participants error:', err);
      setParticipantsModal(prev => prev && prev.match?.id === match.id ? { ...prev, participants: [], error: 'Failed to load participants' } : prev);
    }
    setParticipantsLoading(false);
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
            {(() => {
              const completedMatches = allMatches.filter(m =>
                (m.status || '').toLowerCase() === 'completed' && (m.winner || '').trim()
              );
              /* Only matches with prediction saved to Firestore (not unsaved dropdown selection) */
              const participatedMatches = allMatches.filter(m => savedMatchIds.has(String(m.id)));
              const completedParticipated = completedMatches.filter(m => savedMatchIds.has(String(m.id)));
              const wins = completedParticipated.filter(m => {
                const pred = savedPredictions[String(m.id)] ?? savedPredictions[m.id] ?? '';
                return (pred || '').toString().toLowerCase().trim() === (m.winner || '').toLowerCase().trim();
              }).length;
              const losses = completedParticipated.length - wins;
              const nonPrediction = completedMatches.length - completedParticipated.length;
              const totalPoints = leaderboard.find(u => u.id === user?.uid)?.points ?? 
                completedMatches.reduce((sum, m) => sum + (m.pointResults?.[user?.uid] ?? 0), 0);
              const currentUserEntry = leaderboard.find(u => u.id === user?.uid);
              const leaderboardRank = currentUserEntry?.rank ?? '—';
              return (
                <div className="dashboard-stats">
                  <div className="stats-grid">
                    <button
                      type="button"
                      className="stat-card stat-card-clickable"
                      onClick={() => setShowTodayMatchesModal(true)}
                      title="Click to view today's matches"
                    >
                      <span className="stat-value">{todayMatches.length}</span>
                      <span className="stat-label">Matches today ({today})</span>
                    </button>
                    <button
                      type="button"
                      className="stat-card stat-card-clickable"
                      onClick={() => setShowParticipatedModal(true)}
                      title="Click to view matches and your predictions"
                    >
                      <span className="stat-value">{participatedMatches?.length ?? 0}</span>
                      <span className="stat-label">Matches participated</span>
                    </button>
                    <button
                      type="button"
                      className="stat-card stat-card-clickable"
                      onClick={() => setShowWinsLossesModal(true)}
                      title="Click to view matches (win, loss, or not participated)"
                    >
                      <span className="stat-value">{wins} / {losses} / {nonPrediction}</span>
                      <span className="stat-label">Wins / Losses / Not participated</span>
                    </button>
                    <button
                      type="button"
                      className="stat-card stat-card-clickable"
                      onClick={() => setShowPointsHistoryModal(true)}
                      title="Click to view points history by match"
                    >
                      <span className={`stat-value ${totalPoints >= 0 ? 'points-positive' : 'points-negative'}`}>{totalPoints}</span>
                      <span className="stat-label">Total points</span>
                    </button>
                    <button
                      type="button"
                      className="stat-card stat-card-clickable"
                      onClick={() => setActiveSection('leaderboard')}
                      title="Click to view Leaderboard"
                    >
                      <span className="stat-value">{leaderboardRank === '—' ? '—' : `#${leaderboardRank}`}</span>
                      <span className="stat-label">Leaderboard position</span>
                    </button>
                  </div>
                  {(leaderboardLoading && activeSection === 'dashboard') && <p className="muted">Loading stats...</p>}
                  <p className="muted">Use the sidebar to view Teams, Rules, or Matches in detail.</p>
                </div>
              );
            })()}
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
            <h2>🏆 Leaderboard {!leaderboardLoading && (
              <span className="muted" style={{ fontWeight: 'normal', fontSize: '0.9em' }}>({leaderboard.length} users)</span>
            )}</h2>
            <div className="leaderboard-filters" style={{ marginBottom: '1rem' }}>
              <div className="leaderboard-tab-row">
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
                <button
                  type="button"
                  className={`filter-tag ${showWinnerLoser ? 'active' : ''}`}
                  onClick={() => setShowWinnerLoser(v => !v)}
                  title={`Top ${100 - (leaderboardRawData?.programConfig?.loserPercent ?? 25)}% = winner 🏆, Bottom ${leaderboardRawData?.programConfig?.loserPercent ?? 25}% = loser 📉`}
                >
                  {showWinnerLoser ? '🏆📉' : 'Show winner/loser'}
                </button>
              </div>
              <div className="leaderboard-date-group">
                <label htmlFor="leaderboard-date">Show points up to:</label>
                <div className="leaderboard-date-inputs">
                  <input
                    id="leaderboard-date"
                    type="date"
                    value={leaderboardDate || ''}
                    onChange={(e) => setLeaderboardDate(e.target.value || '')}
                    max={new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString().split('T')[0]}
                    className="date-picker-input"
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setLeaderboardDate('')}
                    title="Show all dates"
                  >
                    All dates
                  </button>
                </div>
              </div>
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
                      const myEntry = leaderboard.find(u => u.id === user.uid);
                      const myRank = myEntry?.rank ?? 0;
                      const myPoints = myEntry?.points ?? 0;
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
                    <div className={`leaderboard-table ${showWinnerLoser ? 'leaderboard-with-wl' : ''}`}>
                      <div className="leaderboard-header">
                        <span>Rank</span>
                        <span>User</span>
                        <span>Points</span>
                        {showWinnerLoser && <span title={`Top ${100 - (leaderboardRawData?.programConfig?.loserPercent ?? 25)}% winner, Bottom ${leaderboardRawData?.programConfig?.loserPercent ?? 25}% loser`}>W/L</span>}
                      </div>
                      {(() => {
                        const n = leaderboard.length;
                        const loserPct = (leaderboardRawData?.programConfig?.loserPercent ?? 25) / 100;
                        const loserCount = n > 0 ? Math.ceil(n * loserPct) : 0;
                        const winnerCount = n - loserCount;
                        const winnerPct = 100 - (leaderboardRawData?.programConfig?.loserPercent ?? 25);
                        return leaderboard.map((u, idx) => {
                          const isWinner = idx < winnerCount;
                          return (
                            <div key={u.id} className={`leaderboard-row ${u.id === user?.uid ? 'current-user' : ''}`}>
                              <span>#{u.rank}</span>
                              <button
                                type="button"
                                className="leaderboard-username-btn"
                                onClick={() => setUserPointHistoryModal(u)}
                                title="View point history"
                              >
                                {toInitCap(u.username || u.email || 'User')}
                              </button>
                              <span className={u.points >= 0 ? 'points-positive' : 'points-negative'}>{u.points}</span>
                              {showWinnerLoser && (
                                <span title={isWinner ? `Winner (top ${winnerPct}%)` : `Loser (bottom ${leaderboardRawData?.programConfig?.loserPercent ?? 25}%)`} className="leaderboard-wl-symbol">
                                  {isWinner ? '🏆' : '📉'}
                                </span>
                              )}
                            </div>
                          );
                        });
                      })()}
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
                      const myEntry = insightLeaderboard.find(u => u.id === user.uid);
                      const myRank = myEntry?.rank ?? 0;
                      const myInsightPoints = myEntry?.insightPoints ?? 0;
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
                    <div className={`leaderboard-table ${showWinnerLoser ? 'leaderboard-with-wl' : ''}`}>
                      <div className="leaderboard-header">
                        <span>Rank</span>
                        <span>User</span>
                        <span>Insight Points</span>
                        {showWinnerLoser && <span title={`Top ${100 - (leaderboardRawData?.programConfig?.loserPercent ?? 25)}% winner, Bottom ${leaderboardRawData?.programConfig?.loserPercent ?? 25}% loser`}>W/L</span>}
                      </div>
                      {(() => {
                        const n = insightLeaderboard.length;
                        const loserPct = (leaderboardRawData?.programConfig?.loserPercent ?? 25) / 100;
                        const loserCount = n > 0 ? Math.ceil(n * loserPct) : 0;
                        const winnerCount = n - loserCount;
                        const loserVal = leaderboardRawData?.programConfig?.loserPercent ?? 25;
                        return insightLeaderboard.map((u, idx) => {
                          const isWinner = idx < winnerCount;
                          return (
                            <div key={u.id} className={`leaderboard-row ${u.id === user?.uid ? 'current-user' : ''}`}>
                              <span>#{u.rank}</span>
                              <span>{toInitCap(u.username || u.email || 'User')}</span>
                              <span className="points-positive">{u.insightPoints ?? 0}</span>
                              {showWinnerLoser && (
                                <span title={isWinner ? `Winner (top ${100 - loserVal}%)` : `Loser (bottom ${loserVal}%)`} className="leaderboard-wl-symbol">
                                  {isWinner ? '🏆' : '📉'}
                                </span>
                              )}
                            </div>
                          );
                        });
                      })()}
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
          </div>

          {activeTab === 'today' && (
            <>
          <h2>Today's Matches ({today})</h2>
          {todayMatches.length > 0 && (
            <>
              <div className="filter-group">
                <span className="filter-label">Match:</span>
                <div className="filter-tags">
                  {matchOptionsToday.map(mo => (
                    <button
                      key={mo.id}
                      type="button"
                      className={`filter-tag ${selectedMatchFilter === mo.id ? 'active' : ''}`}
                      onClick={() => setSelectedMatchFilter(selectedMatchFilter === mo.id ? 'All' : mo.id)}
                    >
                      {mo.label}
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
              {todayMatches.length === 0
                ? "No matches scheduled for today. Check back later!"
                : "No matches match your filters. Try a different match."}
            </p>
          ) : (
            <div className="matches-grid">
              {filteredMatches.map((match, idx) => (
                <div key={match.id} className="match-card">
                  <div className="match-card-icons">
                    {!isPredictionEligible(match) && (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline btn-icon-only"
                        onClick={() => openParticipantsModal(match)}
                        title="View all participants and their predictions"
                        aria-label="View all participants"
                      >
                        👥
                      </button>
                    )}
                    {cricketInsightsConfig.enabled && (match.date || '') <= today && (
                      <button
                        type="button"
                        className={`btn btn-sm btn-insight btn-icon-only ${expandedInsightMatchId === match.id ? 'active' : ''}`}
                        onClick={() => setExpandedInsightMatchId(expandedInsightMatchId === match.id ? null : match.id)}
                        title="Ask or answer Cricket Insights questions"
                        aria-label="Cricket Insights"
                      >
                        <span className="btn-insight-count">{insightQuestionCount[match.id] || 0}</span>
                        💡
                      </button>
                    )}
                  </div>
                  <div className="match-info">
                    <span className="match-number">{match.matchNumber || (idx + 1)}/{maxMatchId}</span>
                    <span className="match-slot">{formatMatchTime(match.time || match.slot)}</span>
                    {(match.thresholdTime || match.time) && (
                      <span className="match-threshold">Predict before {formatMatchTime(match.thresholdTime || match.time)}</span>
                    )}
                    <h3>
                      <span className={selectedMatchFilter === match.id ? 'team-highlight' : ''}>{getTeamCode(match.team1, teams)}</span>
                      {' vs '}
                      <span className={selectedMatchFilter === match.id ? 'team-highlight' : ''}>{getTeamCode(match.team2, teams)}</span>
                    </h3>
                  </div>
                  <div className="match-prediction">
                        {!canUserPredict(userProfile, programConfig) ? (
                      <p className="prediction-closed">Awaiting admin approval. You registered after the match start date. Contact admin to get approval for predictions.</p>
                    ) : !isPredictionEligible(match) ? (
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
                        onChange={(e) => {
                          const val = e.target.value;
                          setPredictions(prev => ({ ...prev, [match.id]: val }));
                        }}
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
                  {savedMatchIds.has(String(match.id)) && (() => {
                    const savedVal = savedPredictions[String(match.id)] ?? savedPredictions[match.id];
                    return savedVal ? <p className="saved-badge">✓ Saved: {getTeamCode(savedVal, teams)}</p> : null;
                  })()}
                  {cricketInsightsConfig.enabled && expandedInsightMatchId === match.id && (
                    <div className="match-insights">
                      <CricketInsights matchId={match.id} matchDate={match.date} matchStatus={match.status} config={cricketInsightsConfig} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
            </>
          )}

          {activeTab === 'history' && (
            <>
              <div className="match-date-filter">
                <label htmlFor="match-date-picker">📅 Date:</label>
                <input
                  id="match-date-picker"
                  type="date"
                  value={matchFilterDate || ''}
                  onChange={(e) => setMatchFilterDate(e.target.value || today)}
                  max={new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString().split('T')[0]}
                  className="date-picker-input"
                />
                <button type="button" className="btn btn-sm" onClick={() => setMatchFilterDate('')} title="Show all dates">All dates</button>
              </div>
              <h2>Matches History {matchFilterDate ? `(${matchFilterDate})` : '(all dates)'}</h2>
              {allMatches.length > 0 && (
                <>
                  <div className="filter-group filter-dropdown-group" style={{ flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <label htmlFor="history-team-filter">Team:</label>
                      <select
                        id="history-team-filter"
                        value={selectedTeamFilter}
                        onChange={(e) => setSelectedTeamFilter(e.target.value)}
                        className="match-filter-select"
                      >
                        <option value="All">All teams</option>
                        {teams.map(t => (
                          <option key={t.id} value={t.name || ''}>
                            {getTeamCode(t.name, teams) || t.name || t.code || t.id}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <label htmlFor="history-match-filter">Match:</label>
                      <select
                        id="history-match-filter"
                        value={selectedHistoryMatchFilter}
                        onChange={(e) => setSelectedHistoryMatchFilter(e.target.value)}
                        className="match-filter-select"
                      >
                        <option value="All">All matches</option>
                        {matchOptionsHistory.map(mo => (
                          <option key={mo.id} value={mo.id}>
                            {mo.date} — {mo.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </>
              )}
              {loading ? (
                <p>Loading matches...</p>
              ) : historyMatches.length === 0 ? (
                <p className="no-matches">
                  {allMatches.length === 0
                    ? 'No matches yet. Check back later!'
                    : selectedTeamFilter !== 'All' && selectedTeamFilter
                      ? 'No matches found for the selected team.'
                      : 'No matches match your filters. Try a different match.'}
                </p>
              ) : (
                <div className="matches-grid history-grid">
                  {historyMatches.map((match, idx) => (
                    <div key={match.id} className="match-card match-card-history">
                      <div className="match-card-icons">
                        {!isPredictionEligible(match) && (
                          <button
                            type="button"
                            className="btn btn-sm btn-outline btn-icon-only"
                            onClick={() => openParticipantsModal(match)}
                            title="View all participants and their predictions"
                            aria-label="View all participants"
                          >
                            👥
                          </button>
                        )}
                        {cricketInsightsConfig.enabled && (match.date || '') <= today && (
                          <button
                            type="button"
                            className={`btn btn-sm btn-insight btn-icon-only ${expandedInsightMatchId === match.id ? 'active' : ''}`}
                            onClick={() => setExpandedInsightMatchId(expandedInsightMatchId === match.id ? null : match.id)}
                            title="Ask or answer Cricket Insights questions"
                            aria-label="Cricket Insights"
                          >
                            <span className="btn-insight-count">{insightQuestionCount[match.id] || 0}</span>
                            💡
                          </button>
                        )}
                      </div>
                      <div className="match-info">
                        <span className="match-number">{match.matchNumber || (idx + 1)}/{maxMatchId}</span>
                        <div className="match-meta-row">
                          <span className="match-date">{match.date}</span>
                          <span className="match-slot">{formatMatchTime(match.time || match.slot)}</span>
                          <span className={`match-status-badge ${(match.status || 'open').toLowerCase() === 'completed' ? 'completed' : match.date === today ? 'today' : 'open'}`}>
                            {(match.status || 'open').toLowerCase() === 'completed'
                              ? 'completed'
                              : match.date === today
                                ? 'today'
                                : 'upcoming'}
                          </span>
                        </div>
                        <h3>
                          <span className={selectedHistoryMatchFilter === match.id ? 'team-highlight' : ''}>{getTeamCode(match.team1, teams)}</span>
                          {' vs '}
                          <span className={selectedHistoryMatchFilter === match.id ? 'team-highlight' : ''}>{getTeamCode(match.team2, teams)}</span>
                        </h3>
                        {match.winner && <p className="match-winner-badge">🏆 Winner: {getTeamCode(match.winner, teams)}</p>}
                      </div>
                      {(() => {
                        const displayVal = savedMatchIds.has(String(match.id))
                          ? (savedPredictions[String(match.id)] ?? savedPredictions[match.id])
                          : null;
                        return displayVal ? <p className="saved-badge">✓ Your prediction: {getTeamCode(displayVal, teams)}</p> : null;
                      })()}
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
                      {cricketInsightsConfig.enabled && expandedInsightMatchId === match.id && (
                        <div className="match-insights">
                          <CricketInsights matchId={match.id} matchDate={match.date} matchStatus={match.status} config={cricketInsightsConfig} />
                        </div>
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
              <div className={`alert alert-toast ${cpMessage.includes('success') ? 'alert-success' : 'alert-error'}`}>
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
            {surrenderError && <div className="alert alert-error alert-toast">{surrenderError}</div>}
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

      {participantsModal && (
        <div className="modal-overlay" onClick={() => !participantsLoading && setParticipantsModal(null)}>
          <div className="modal-content participants-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                Participants — {getTeamCode(participantsModal.match?.team1, teams)} vs {getTeamCode(participantsModal.match?.team2, teams)}
              </h3>
              <button type="button" className="modal-close" onClick={() => !participantsLoading && setParticipantsModal(null)} aria-label="Close">&times;</button>
            </div>
            {participantsLoading ? (
              <p className="muted">Loading participants...</p>
            ) : participantsModal.error ? (
              <p className="alert alert-error">{participantsModal.error}</p>
            ) : !participantsModal.participants || participantsModal.participants.length === 0 ? (
              <p className="muted">No users registered yet.</p>
            ) : (
              <>
                {(() => {
                  const m = participantsModal.match;
                  const isCompleted = (m?.status || '').toLowerCase() === 'completed' && (m?.winner || '').trim();
                  const pointResults = m?.pointResults && typeof m.pointResults === 'object' ? m.pointResults : null;
                  const showPoints = isCompleted && pointResults;
                  return (
                    <>
                      {showPoints && (
                        <p className="muted participants-points-note">Points shown for completed match with winner declared.</p>
                      )}
                      <ul className="participants-list">
                        <li className={`participants-list-header ${!showPoints ? 'participants-list-header-2col' : ''}`}>
                          <span>User</span>
                          <span>Prediction</span>
                          {showPoints && <span className="col-points">Points</span>}
                        </li>
                        {participantsModal.participants.map((p, i) => {
                    const pts = showPoints && p.userId ? pointResults[p.userId] : undefined;
                    const ptsNum = pts != null && !Number.isNaN(Number(pts)) ? to2Decimals(Number(pts)) : null;
                    return (
                      <li key={p.userId || i} className={`participant-item ${!showPoints ? 'participant-item-no-points' : ''}`}>
                        <span className="participant-name">{p.displayName}</span>
                        <span className="participant-prediction">{p.predictedWinner ? (getTeamCode(p.predictedWinner, teams) || p.predictedWinner) : '—'}</span>
                        {showPoints && (
                          <span className={`participant-points ${ptsNum != null && ptsNum >= 0 ? 'points-positive' : 'points-negative'}`}>
                            {ptsNum != null ? (ptsNum >= 0 ? '+' : '') + ptsNum : '—'}
                          </span>
                        )}
                      </li>
                    );
                  })}
                        </ul>
                    </>
                  );
                })()}
              </>
            )}
          </div>
        </div>
      )}

      {showPointsHistoryModal && createPortal(
        <div className="modal-overlay" onClick={() => setShowPointsHistoryModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Points History</h3>
              <button type="button" className="modal-close" onClick={() => setShowPointsHistoryModal(false)} aria-label="Close">&times;</button>
            </div>
            {(() => {
              const completed = allMatches
                .filter(m => (m.status || '').toLowerCase() === 'completed' && (m.winner || '').trim())
                .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
              let runningTotal = 0;
              return completed.length === 0 ? (
                <p className="muted">No completed matches yet.</p>
              ) : (
                <ul className="points-history-list">
                  {completed.map((m) => {
                    const predPoints = m.pointResults?.[user?.uid];
                    const insightPts = to2Decimals(insightPointsByMatch[m.id] ?? 0);
                    const predVal = predPoints != null ? Number(predPoints) : 0;
                    runningTotal = to2Decimals(runningTotal + predVal + (insightPointsByMatch[m.id] ?? 0));
                    const dispPred = predPoints != null ? to2Decimals(predPoints) : null;
                    return (
                      <li key={m.id} className="points-history-item">
                        <span className="points-history-match">
                          #{m.matchNumber || m.id} {getTeamCode(m.team1, teams)} vs {getTeamCode(m.team2, teams)} ({m.date})
                        </span>
                        <span className="points-history-detail">
                          {dispPred != null ? (
                            <span className={dispPred >= 0 ? 'points-positive' : 'points-negative'}>Prediction: {dispPred >= 0 ? '+' : ''}{dispPred}</span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                          {insightPts > 0 && (
                            <span className="points-positive"> · Insight: +{insightPts}</span>
                          )}
                          <span className="points-history-total"> → {runningTotal}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              );
            })()}
          </div>
        </div>,
        document.body
      )}

      {userPointHistoryModal && createPortal(
        <div className="modal-overlay" onClick={() => setUserPointHistoryModal(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Point History — {toInitCap(userPointHistoryModal.username || userPointHistoryModal.email || 'User')}</h3>
              <button type="button" className="modal-close" onClick={() => setUserPointHistoryModal(null)} aria-label="Close">&times;</button>
            </div>
            {(() => {
              const matches = leaderboardRawData?.allMatches || [];
              const progConfig = leaderboardRawData?.programConfig || {};
              const matchStartDate = (progConfig.matchStartDate || '').trim();
              const createdAtDate = (userPointHistoryModal.createdAt || '').toString().split('T')[0];
              const isLateUser = matchStartDate && createdAtDate && createdAtDate >= matchStartDate;
              if (isLateUser) {
                const totalPts = userPointHistoryModal.points ?? 0;
                return (
                  <p className="muted">
                    This user joined on or after match start date ({matchStartDate}). Points are allocated as the bottom ranked user total, not match-wise.
                    <br />
                    <strong>Total points: {to2Decimals(totalPts)}</strong>
                  </p>
                );
              }
              let completed = matches
                .filter(m => (m.status || '').toLowerCase() === 'completed' && (m.winner || '').trim())
                .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
              if (leaderboardDate) {
                completed = completed.filter(m => (m.date || '') <= leaderboardDate);
              }
              const uid = userPointHistoryModal.id;
              let runningTotal = 0;
              return completed.length === 0 ? (
                <p className="muted">No completed matches for the selected date range.</p>
              ) : (
                <ul className="points-history-list">
                  {completed.map((m) => {
                    const predPoints = m.pointResults?.[uid];
                    const predVal = predPoints != null ? Number(predPoints) : 0;
                    runningTotal = to2Decimals(runningTotal + predVal);
                    const dispPts = predPoints != null ? to2Decimals(predPoints) : null;
                    return (
                      <li key={m.id} className="points-history-item">
                        <span className="points-history-match">
                          #{m.matchNumber || m.id} {getTeamCode(m.team1, teams)} vs {getTeamCode(m.team2, teams)} ({m.date})
                        </span>
                        <span className="points-history-detail">
                          {dispPts != null ? (
                            <span className={dispPts >= 0 ? 'points-positive' : 'points-negative'}>
                              {dispPts >= 0 ? '+' : ''}{dispPts}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                          <span className="points-history-total"> → {runningTotal}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              );
            })()}
          </div>
        </div>,
        document.body
      )}

      {showWinsLossesModal && createPortal(
        <div className="modal-overlay" onClick={() => setShowWinsLossesModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Wins / Losses / Not participated</h3>
              <button type="button" className="modal-close" onClick={() => setShowWinsLossesModal(false)} aria-label="Close">&times;</button>
            </div>
            {(() => {
              const completed = allMatches
                .filter(m => (m.status || '').toLowerCase() === 'completed' && (m.winner || '').trim())
                .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
              const participated = completed.filter(m => savedMatchIds.has(String(m.id)));
              const noPrediction = completed.filter(m => !savedMatchIds.has(String(m.id)));
              if (participated.length === 0 && noPrediction.length === 0) {
                return <p className="muted">No completed matches yet.</p>;
              }
              return (
                <>
                  {participated.length > 0 && (
                    <>
                      <h4 style={{ marginTop: 0 }}>Wins &amp; Losses</h4>
                      <ul className="points-history-list">
                        {participated.map((m) => {
                          const pred = (savedPredictions[String(m.id)] ?? savedPredictions[m.id] ?? '').toString().toLowerCase().trim();
                          const winner = (m.winner || '').toLowerCase().trim();
                          const isWin = pred === winner;
                          return (
                            <li key={m.id} className="points-history-item">
                              <span className="points-history-match">
                                #{m.matchNumber || m.id} {getTeamCode(m.team1, teams)} vs {getTeamCode(m.team2, teams)} ({m.date})
                              </span>
                              <span className={`points-history-detail ${isWin ? 'points-positive' : 'points-negative'}`}>
                                {isWin ? '✓ Win' : '✗ Loss'} — Predicted {getTeamCode(pred, teams) || pred || '?'}, winner: {getTeamCode(m.winner, teams) || m.winner}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                  {noPrediction.length > 0 && (
                    <>
                      <h4>Not participated ({noPrediction.length})</h4>
                      <ul className="points-history-list">
                        {noPrediction.map((m) => (
                          <li key={m.id} className="points-history-item">
                            <span className="points-history-match">
                              #{m.matchNumber || m.id} {getTeamCode(m.team1, teams)} vs {getTeamCode(m.team2, teams)} ({m.date})
                            </span>
                            <span className="points-history-detail muted">
                              Did not predict · Winner: {getTeamCode(m.winner, teams) || m.winner}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              );
            })()}
          </div>
        </div>,
        document.body
      )}

      {showTodayMatchesModal && createPortal(
        <div className="modal-overlay" onClick={() => setShowTodayMatchesModal(false)}>
          <div className="modal-content modal-today-matches" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Matches Today ({today})</h3>
              <button type="button" className="modal-close" onClick={() => setShowTodayMatchesModal(false)} aria-label="Close">&times;</button>
            </div>
            {todayMatches.length === 0 ? (
              <p className="muted">No matches scheduled for today.</p>
            ) : (
              <ul className="today-matches-modal-list">
                {[...todayMatches].sort((a, b) => (a.time || '00:00').localeCompare(b.time || '00:00')).map((m) => {
                  const predicted = predictions[String(m.id)] ?? predictions[m.id] ?? '';
                  const eligible = isPredictionEligible(m);
                  return (
                    <li key={m.id} className="today-match-modal-item">
                      <div className="today-match-modal-header">
                        <span className="today-match-modal-teams">
                          #{m.matchNumber || m.id} {getTeamCode(m.team1, teams)} vs {getTeamCode(m.team2, teams)}
                        </span>
                        <span className="today-match-modal-meta">
                          {formatMatchTime(m.time || m.slot)} · Predict before {formatMatchTime(m.thresholdTime || m.time)}
                          <span className="muted"> · {(m.status || 'open').toLowerCase() === 'completed' ? 'completed' : m.date === today ? 'today' : 'upcoming'}</span>
                        </span>
                      </div>
                      {!canUserPredict(userProfile, programConfig) ? (
                        <p className="prediction-closed">Awaiting admin approval to predict. Contact admin.</p>
                      ) : eligible ? (
                        <div className="today-match-modal-prediction">
                          <label>Predict winner:</label>
                          <div className="prediction-row">
                            <select
                              value={predicted || ''}
                              onChange={(e) => {
                                const val = e.target.value;
                                setPredictions(prev => ({ ...prev, [m.id]: val }));
                              }}
                              disabled={saving === m.id}
                            >
                              <option value="">Select...</option>
                              <option value={m.team1}>{getTeamCode(m.team1, teams)}</option>
                              <option value={m.team2}>{getTeamCode(m.team2, teams)}</option>
                            </select>
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => predicted && handleSavePrediction(m.id, predicted, m)}
                              disabled={!predicted || saving === m.id}
                            >
                              {saving === m.id ? 'Saving...' : 'Save'}
                            </button>
                          </div>
                          {savedMatchIds.has(String(m.id)) && (() => {
                            const savedVal = savedPredictions[String(m.id)] ?? savedPredictions[m.id];
                            return savedVal ? <p className="saved-badge">✓ Saved: {getTeamCode(savedVal, teams)}</p> : null;
                          })()}
                        </div>
                      ) : (
                        <div className="today-match-modal-closed">
                          {(() => {
                            const sv = savedPredictions[String(m.id)] ?? savedPredictions[m.id];
                            return sv ? (
                              <span className="points-positive">Your prediction: <strong>{getTeamCode(sv, teams) || sv}</strong></span>
                            ) : (
                              <span className="muted">Prediction closed.</span>
                            );
                          })()}
                          {m.winner && <span className="match-winner-badge">🏆 Winner: {getTeamCode(m.winner, teams)}</span>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>,
        document.body
      )}

      {showParticipatedModal && createPortal(
        <div className="modal-overlay" onClick={() => setShowParticipatedModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Matches Participated</h3>
              <button type="button" className="modal-close" onClick={() => setShowParticipatedModal(false)} aria-label="Close">&times;</button>
            </div>
            {(() => {
              const participated = allMatches
                .filter(m => savedMatchIds.has(String(m.id)))
                .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
              return participated.length === 0 ? (
                <p className="muted">No participated matches yet.</p>
              ) : (
                <ul className="points-history-list">
                  {participated.map((m) => {
                    const predicted = savedPredictions[String(m.id)] ?? savedPredictions[m.id] ?? '';
                    const isCompleted = (m.status || '').toLowerCase() === 'completed' && (m.winner || '').trim();
                    return (
                      <li key={m.id} className="points-history-item">
                        <span className="points-history-match">
                          #{m.matchNumber || m.id} {getTeamCode(m.team1, teams)} vs {getTeamCode(m.team2, teams)} ({m.date})
                        </span>
                        <span className="points-history-detail">
                          Predicted: <strong>{getTeamCode(predicted, teams) || predicted || '—'}</strong>
                          {isCompleted && (
                            <span className="muted"> · Winner: {getTeamCode(m.winner, teams) || m.winner}</span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              );
            })()}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
