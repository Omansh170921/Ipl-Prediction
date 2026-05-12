import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { collection, addDoc, getDocs, getDoc, doc, setDoc, updateDoc, deleteDoc, deleteField, query, where, increment, runTransaction, writeBatch, Timestamp } from 'firebase/firestore';
import { db, callFunction } from '../firebase/config';
import Sidebar from '../components/Sidebar';
import { toInitCap } from '../utils/format';
import { calculateMatchPoints, getMatchPointsMultiplier, to2Decimals } from '../utils/points';
import {
  isDrawOrCancelledWinner,
  MATCH_WINNER_DRAW,
  MATCH_WINNER_CANCELLED,
  getMatchResultLabel,
} from '../utils/matchOutcomes';
import { getMatchPredictionCutoffDate, isPredictionEligible } from '../utils/match';
import { getAppTodayDate } from '../utils/calendarDate';
import { getPredictionSavedIso, formatTimeHH24 } from '../utils/predictionTime';
import {
  getSortedPredictionChangeLog,
  formatPredictionHistoryLocalTime,
} from '../utils/predictionChangeLog';
import { formatInsightUserLabel } from '../utils/insightQuestions';
import { getInsightWrongAnswerPenalty, insightPointDeltaOnAnswerChange } from '../utils/insightScoring';
import PredictionContextsAdminPanel from '../components/PredictionContextsAdminPanel';
import * as XLSX from 'xlsx';

/** Persists server-side cutoff for Firestore rules (Cricket Insights + predictions). */
function withPredictionCutoffAt(matchFields) {
  const cutoff = getMatchPredictionCutoffDate(matchFields);
  return {
    ...matchFields,
    ...(cutoff ? { predictionCutoffAt: Timestamp.fromDate(cutoff) } : {}),
  };
}

function formatMatchTime(time) {
  if (!time) return 'TBD';
  if (time.includes(':') && /^\d{1,2}:\d{2}$/.test(time)) {
    const [h, m] = time.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
  }
  return time;
}

const PLAYER_TYPES = ['Batsman', 'Bowler', 'All Rounder', 'Wicket Keeper'];

const PLAYER_ROLES = [
  { value: 'player', label: 'Player' },
  { value: 'captain', label: 'Captain' },
  { value: 'viceCaptain', label: 'Vice Captain' },
];

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

function setPlayerRole(players, index, newRole) {
  const next = players.map((p, i) => {
    if (i !== index) {
      if (newRole === 'captain' && p.role === 'captain') return { ...p, role: 'player' };
      if (newRole === 'viceCaptain' && p.role === 'viceCaptain') return { ...p, role: 'player' };
      return p;
    }
    return { ...p, role: newRole };
  });
  return next;
}

function parseImportedPlayers(jsonString) {
  let arr;
  try {
    const parsed = JSON.parse(jsonString);
    arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.players) ? parsed.players : null);
    if (!arr) throw new Error('JSON must be an array of players or { players: [...] }');
  } catch (e) {
    return { error: e.message || 'Invalid JSON' };
  }
  const validTypes = new Set(PLAYER_TYPES);
  let players = [];
  const normRole = (r) => {
    const s = (r || 'player').toString().toLowerCase().trim();
    if (s === 'captain' || s === 'c') return 'captain';
    if (s === 'vicecaptain' || s === 'vice captain' || s === 'vc') return 'viceCaptain';
    return 'player';
  };
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    const name = typeof p === 'string' ? p.trim() : (p?.name != null ? String(p.name).trim() : '');
    if (!name) continue;
    const active = p?.active !== false;
    let type = (p?.type || 'Batsman').trim();
    if (!PLAYER_TYPES.includes(type)) type = 'Batsman';
    const role = normRole(p?.role);
    players.push({ name, active, type, role });
  }
  if (players.length === 0) return { error: 'No valid players found' };
  for (let i = 0; i < players.length; i++) {
    players = setPlayerRole(players, i, players[i].role);
  }
  return { players };
}

function parseImportedMatches(jsonString) {
  let arr;
  try {
    const parsed = JSON.parse(jsonString);
    arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.matches) ? parsed.matches : null);
    if (!arr) throw new Error('JSON must be an array of matches or { matches: [...] }');
  } catch (e) {
    return { error: e.message || 'Invalid JSON' };
  }
  const matches = [];
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i];
    const team1 = (m?.team1 || '').toString().trim().toUpperCase();
    const team2 = (m?.team2 || '').toString().trim().toUpperCase();
    const date = (m?.date || '').toString().trim();
    if (!team1 || !team2 || !date) continue;
    if (team1 === team2) continue;
    const time = (m?.time || m?.slot || '19:00').toString().trim();
    const thresholdTime = (m?.thresholdTime || '18:00').toString().trim();
    const status = (m?.status || 'open').toString().trim().toLowerCase();
    const matchNumber = (m?.matchNumber ?? m?.matchId ?? String(i + 1)).toString().trim();
    const stadium = (m?.stadium || '').toString().trim();
    const city = (m?.city || '').toString().trim();
    const row = {
      matchNumber: matchNumber || String(i + 1),
      team1,
      team2,
      date,
      time: /^\d{1,2}:\d{2}$/.test(time) ? time : '19:00',
      thresholdTime: /^\d{1,2}:\d{2}$/.test(thresholdTime) ? thresholdTime : '18:00',
      status: status || 'open',
    };
    if (stadium) row.stadium = stadium;
    if (city) row.city = city;
    const cv = (m?.crowdPredictionVisibility ?? '').toString().trim().toLowerCase();
    if (cv === 'always' || cv === 'aftercutoff') {
      row.crowdPredictionVisibility = cv === 'aftercutoff' ? 'afterCutoff' : 'always';
    }
    const matchNameImp = (m?.matchName ?? m?.matchTitle ?? '').toString().trim();
    if (matchNameImp) row.matchName = matchNameImp;
    const pmRaw = m?.pointsMultiplier;
    if (pmRaw != null && pmRaw !== '') {
      const multNum = typeof pmRaw === 'number' ? pmRaw : parseFloat(String(pmRaw).replace(',', '.'));
      if (Number.isFinite(multNum) && multNum > 0 && multNum !== 1) row.pointsMultiplier = multNum;
    }
    matches.push(row);
  }
  if (matches.length === 0) return { error: 'No valid matches found. Each match needs team1, team2, date.' };
  return { matches };
}

export default function Admin() {
  const { user, userProfile, logout } = useAuth();
  const [teams, setTeams] = useState([]);
  const [rules, setRules] = useState([]);
  const [matches, setMatches] = useState([]);
  const [newTeam, setNewTeam] = useState('');
  const [newTeamCode, setNewTeamCode] = useState('');
  const [newTeamPlayers, setNewTeamPlayers] = useState([]);
  const [newPlayerInput, setNewPlayerInput] = useState('');
  const [newPlayerType, setNewPlayerType] = useState('Batsman');
  const [newPlayerActive, setNewPlayerActive] = useState(true);
  const [newPlayerRole, setNewPlayerRole] = useState('player');
  const [newRuleKey, setNewRuleKey] = useState('');
  const [newRuleValue, setNewRuleValue] = useState('');
  const [newRulePosition, setNewRulePosition] = useState('');
  const [matchForm, setMatchForm] = useState({
    matchName: '',
    matchNumber: '',
    team1: '',
    team2: '',
    date: '',
    time: '19:00',
    thresholdTime: '18:00',
    stadium: '',
    city: '',
    crowdPredictionVisibility: 'inherit',
    pointsMultiplier: '',
  });
  const [editingMatch, setEditingMatch] = useState(null);
  const [editingTeam, setEditingTeam] = useState(null);
  const [editPlayerInput, setEditPlayerInput] = useState('');
  const [editPlayerType, setEditPlayerType] = useState('Batsman');
  const [editPlayerActive, setEditPlayerActive] = useState(true);
  const [editPlayerRole, setEditPlayerRole] = useState('player');
  const [importJsonText, setImportJsonText] = useState('');
  const [importError, setImportError] = useState('');
  const [importMatchJsonText, setImportMatchJsonText] = useState('');
  const [importMatchError, setImportMatchError] = useState('');
  const [importMatchLoading, setImportMatchLoading] = useState(false);
  const [selectedMatchIds, setSelectedMatchIds] = useState([]);
  const [bulkDeleteLoading, setBulkDeleteLoading] = useState(false);
  const [expandedTeamId, setExpandedTeamId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [activeSection, setActiveSection] = useState('matches');
  const [pointRules, setPointRules] = useState({ notParticipatedPoints: 7, wrongPredictionPoints: 5 });
  const [passwordPolicy, setPasswordPolicy] = useState({ maxPasswordChanges: 2, surrenderDeadline: '' });
  const [programConfig, setProgramConfig] = useState({
    matchStartDate: '',
    scheduleIntervalMinutes: 10,
    loserPercent: 25,
    crowdPredictionVisibility: 'always',
    crowdPredictionMinutesAfterCutoff: 10,
    notifyOnPointsCalculated: true,
  });
  const [cricketInsightsConfig, setCricketInsightsConfig] = useState({
    enabled: true,
    maxQuestionsPerUserPerMatch: 1,
    maxQuestionsPerMatch: 5,
    insightApproverIds: [],
    requiredApprovals: 1,
    insightWrongAnswerPenalty: 0.25,
    allowInsightQuestionsAfterPredictionCutoff: false,
    allowInsightAnswersAfterPredictionCutoff: false,
  });
  const [usernameLookupList, setUsernameLookupList] = useState([]);
  const [calculatingMatchId, setCalculatingMatchId] = useState(null);
  const [removingUserId, setRemovingUserId] = useState(null);
  const [approvingUserId, setApprovingUserId] = useState(null);
  const [setPasswordUser, setSetPasswordUser] = useState(null);
  const [adminSetPasswordNew, setAdminSetPasswordNew] = useState('');
  const [adminSetPasswordConfirm, setAdminSetPasswordConfirm] = useState('');
  const [adminSetPasswordLoading, setAdminSetPasswordLoading] = useState(false);
  const [removingRuleId, setRemovingRuleId] = useState(null);
  const [editingRule, setEditingRule] = useState(null);
  const [allUsers, setAllUsers] = useState([]);
  const [usersFetchError, setUsersFetchError] = useState(null);
  const [pendingQuestions, setPendingQuestions] = useState([]);
  const [questionsAwaitingAnswer, setQuestionsAwaitingAnswer] = useState([]);
  /** Approved questions with a correct answer already set (admin may change answer and reconcile points). */
  const [answeredInsightQuestions, setAnsweredInsightQuestions] = useState([]);
  const [insightApprovalLoading, setInsightApprovalLoading] = useState(false);
  const [approvingQid, setApprovingQid] = useState(null);
  const [rejectingQid, setRejectingQid] = useState(null);
  const [removingQid, setRemovingQid] = useState(null);
  const [togglingAnswersQid, setTogglingAnswersQid] = useState(null);
  const [answerModalQuestion, setAnswerModalQuestion] = useState(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [correctAnswerInput, setCorrectAnswerInput] = useState('');
  const [submittingAnswer, setSubmittingAnswer] = useState(false);
  const [expandedInsightMatchId, setExpandedInsightMatchId] = useState(null);
  const [participantsModal, setParticipantsModal] = useState(null);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  /** { match, displayName, entries: { predictedWinner, atIso }[] } */
  const [predictionHistoryModal, setPredictionHistoryModal] = useState(null);
  const [pointsExportFrom, setPointsExportFrom] = useState(() => {
    const t = getAppTodayDate();
    const [y, m] = t.split('-').map(Number);
    return `${y}-${String(m).padStart(2, '0')}-01`;
  });
  const [pointsExportTo, setPointsExportTo] = useState(() => getAppTodayDate());
  const [pointsExportLoading, setPointsExportLoading] = useState(false);
  /** { match } when the send-notification modal is open */
  const [matchNotifyModal, setMatchNotifyModal] = useState(null);
  const [matchNotifyUserIds, setMatchNotifyUserIds] = useState([]);
  const [matchNotifyTitle, setMatchNotifyTitle] = useState('');
  const [matchNotifyBody, setMatchNotifyBody] = useState('');
  const [matchNotifySending, setMatchNotifySending] = useState(false);
  /** When set, a single-user immediate send is in progress (FCM to that uid only). */
  const todayCal = getAppTodayDate();

  const matchNotifyEligibleUsers = useMemo(
    () =>
      allUsers
        .filter((u) => u.id !== user?.uid && u.isAdmin !== true && u.isAdmin !== 'true')
        .sort((a, b) => (a.username || a.email || '').localeCompare(b.username || b.email || '', undefined, { sensitivity: 'base' })),
    [allUsers, user?.uid]
  );

  const openParticipantsModal = async (match) => {
    if (!match?.id) return;
    setParticipantsModal({ match, participants: null });
    setParticipantsLoading(true);
    try {
      const [matchSnap, predsSnap] = await Promise.all([
        getDoc(doc(db, 'matches', match.id)),
        getDocs(query(collection(db, 'predictions'), where('matchId', '==', match.id))),
      ]);
      const matchData = matchSnap?.exists?.() ? { id: matchSnap.id, ...matchSnap.data() } : match;
      const predMap = new Map();
      predsSnap.docs.forEach(d => {
        const data = d.data();
        const userId = data.userId ?? data.uid ?? d.id?.split('_')?.[0];
        predMap.set(userId, {
          predictedWinner: data.predictedWinner,
          predictedAtIso: getPredictionSavedIso(data),
          changeLogSorted: getSortedPredictionChangeLog(data),
        });
      });
      const allUsersList = (allUsers || []).filter(u => !u.isAdmin && u.isAdmin !== 'true');
      const participants = allUsersList.map(u => {
        const displayName = u?.username ? toInitCap(String(u.username || '').replace(/_/g, ' ')) : (u?.email || u.id || '—');
        const pred = predMap.get(u.id);
        const predictedWinner = pred?.predictedWinner ?? null;
        const predictedAtIso = pred?.predictedAtIso ?? null;
        const changeLogSorted = pred?.changeLogSorted ?? [];
        return { userId: u.id, predictedWinner, predictedAtIso, displayName, changeLogSorted };
      }).sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
      setParticipantsModal(prev => prev && prev.match?.id === match.id ? { ...prev, match: matchData, participants } : prev);
    } catch (err) {
      console.error('Fetch participants error:', err);
      setParticipantsModal(prev => prev && prev.match?.id === match.id ? { ...prev, participants: [], error: 'Failed to load participants' } : prev);
    }
    setParticipantsLoading(false);
  };

  const fetchData = async () => {
    const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), ms));
    setUsersFetchError(null);
    try {
      const usersPromise = getDocs(collection(db, 'users')).catch((err) => {
        setUsersFetchError(err.message || 'Failed to load users');
        return { docs: [] };
      });
      const [teamsSnap, rulesSnap, matchesSnap, usersSnap] = await Promise.race([
        Promise.all([
          getDocs(collection(db, 'teams')).catch(() => ({ docs: [] })),
          getDocs(collection(db, 'rules')).catch(() => ({ docs: [] })),
          getDocs(collection(db, 'matches')).catch(() => ({ docs: [] })),
          usersPromise,
        ]),
        timeout(20000),
      ]);
      setAllUsers((usersSnap?.docs || []).map(d => ({ id: d.id, uid: d.id, ...d.data() })));
      setTeams((teamsSnap?.docs || []).map(d => ({ id: d.id, ...d.data() })));
      setRules((rulesSnap?.docs || []).filter(d => d.id !== 'pointRules').map(d => ({ id: d.id, ...d.data() })));
      setMatches((matchesSnap?.docs || []).map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
        const aCompleted = (a.status || '').toLowerCase() === 'completed';
        const bCompleted = (b.status || '').toLowerCase() === 'completed';
        if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;
        return (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || '');
      }));

      setMatchForm(prev => ({
        ...prev,
        date: prev.date || getAppTodayDate(),
      }));

      try {
        const ptSnap = await getDoc(doc(db, 'rules', 'pointRules'));
        if (ptSnap.exists()) {
          const d = ptSnap.data();
          if (d.notParticipatedPoints != null || d.wrongPredictionPoints != null) {
            setPointRules(prev => ({ ...prev, ...d }));
          }
        }
      } catch {
        // use defaults
      }
      try {
        const ppSnap = await getDoc(doc(db, 'settings', 'passwordPolicy'));
        if (ppSnap.exists()) {
          const d = ppSnap.data();
          setPasswordPolicy(prev => ({
            ...prev,
            maxPasswordChanges: d.maxPasswordChanges ?? 2,
            surrenderDeadline: d.surrenderDeadline || '',
          }));
        }
      } catch {
        // use defaults
      }
      try {
        const progSnap = await getDoc(doc(db, 'settings', 'programConfig'));
        if (progSnap.exists()) {
          const d = progSnap.data();
          setProgramConfig({
            matchStartDate: d.matchStartDate || '',
            scheduleIntervalMinutes: d.scheduleIntervalMinutes ?? 10,
            loserPercent: d.loserPercent ?? 25,
            crowdPredictionVisibility: d.crowdPredictionVisibility === 'afterCutoff' ? 'afterCutoff' : 'always',
            crowdPredictionMinutesAfterCutoff:
              d.crowdPredictionMinutesAfterCutoff != null && d.crowdPredictionMinutesAfterCutoff !== ''
                ? Number(d.crowdPredictionMinutesAfterCutoff)
                : 10,
            notifyOnPointsCalculated: d.notifyOnPointsCalculated !== false,
          });
        }
      } catch {
        // use defaults
      }
      try {
        const ciSnap = await getDoc(doc(db, 'settings', 'cricketInsights'));
        if (ciSnap.exists()) {
          const d = ciSnap.data();
          const approverIds = Array.isArray(d.insightApproverIds) ? d.insightApproverIds : [];
          setCricketInsightsConfig(prev => ({
            ...prev,
            enabled: d.enabled !== false,
            maxQuestionsPerUserPerMatch: Math.max(1, Math.min(10, d.maxQuestionsPerUserPerMatch ?? 1)),
            maxQuestionsPerMatch: Math.max(1, Math.min(20, d.maxQuestionsPerMatch ?? 5)),
            insightApproverIds: approverIds,
            requiredApprovals: Math.max(1, Math.min(10, d.requiredApprovals ?? 1)),
            insightWrongAnswerPenalty:
              d.insightWrongAnswerPenalty != null && d.insightWrongAnswerPenalty !== ''
                ? Number(d.insightWrongAnswerPenalty)
                : 0.25,
            allowInsightQuestionsAfterPredictionCutoff: d.allowInsightQuestionsAfterPredictionCutoff === true,
            allowInsightAnswersAfterPredictionCutoff: d.allowInsightAnswersAfterPredictionCutoff === true,
          }));
        }
      } catch {
        // use defaults
      }
    } catch (err) {
      console.error('Admin fetch error:', err);
      setMessage('Error loading data: ' + (err.message || 'Please check your connection.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    const fetchUsernameLookup = async () => {
      if (activeSection !== 'passwordPolicy') return;
      try {
        const snap = await getDocs(collection(db, 'usernameLookup'));
        setUsernameLookupList(snap.docs.map(d => ({ username: d.id, userId: d.data().userId })));
      } catch (err) {
        console.error('Fetch usernameLookup error:', err);
      }
    };
    fetchUsernameLookup();
  }, [activeSection]);

  useEffect(() => {
    const fetchInsightQuestions = async () => {
      if (activeSection !== 'matches') return;
      setInsightApprovalLoading(true);
      try {
        const [pendingSnap, awaitingSnap, answeredSnap] = await Promise.all([
          getDocs(query(
            collection(db, 'cricket_questions'),
            where('approved', '==', false),
            where('status', '==', 'pending')
          )),
          getDocs(query(
            collection(db, 'cricket_questions'),
            where('approved', '==', true),
            where('correctAnswer', '==', null)
          )),
          getDocs(query(
            collection(db, 'cricket_questions'),
            where('approved', '==', true),
            where('status', '==', 'answered')
          )),
        ]);
        setPendingQuestions(pendingSnap.docs.map(d => ({ id: d.id, ...d.data() })));
        setQuestionsAwaitingAnswer(awaitingSnap.docs.map(d => ({ id: d.id, ...d.data() })));
        setAnsweredInsightQuestions(answeredSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      } catch (err) {
        console.error('Fetch insight questions error:', err);
        setMessage('Error loading questions: ' + (err.message || ''));
      }
      setInsightApprovalLoading(false);
    };
    fetchInsightQuestions();
  }, [activeSection]);

  useAutoDismiss(message, setMessage);

  const setMatchNotifyUserChecked = (rawId, checked) => {
    const uid = rawId != null ? String(rawId).trim() : '';
    if (!uid) return;
    setMatchNotifyUserIds((prev) => {
      const has = prev.some((x) => String(x) === uid);
      if (checked && !has) return [...prev, uid];
      if (!checked && has) return prev.filter((x) => String(x) !== uid);
      return prev;
    });
  };

  const openMatchNotifyModal = (m) => {
    if (!m?.id) return;
    setMatchNotifyModal({ match: m });
    setMatchNotifyTitle('');
    setMatchNotifyBody('');
    setMatchNotifyUserIds([]);
  };

  const handleSendMatchNotifications = async () => {
    const mid = matchNotifyModal?.match?.id;
    if (!mid) {
      setMessage('No match selected.');
      return;
    }
    const selectedIds = [...new Set(matchNotifyUserIds)]
      .map((id) => (typeof id === 'string' ? id.trim() : String(id || '').trim()))
      .filter(Boolean);
    if (selectedIds.length === 0) {
      setMessage('Tick at least one user to send only to those users.');
      return;
    }
    setMatchNotifySending(true);
    try {
      const title = matchNotifyTitle.trim() || undefined;
      const body = matchNotifyBody.trim() || undefined;
      const matchId = String(mid);

      if (selectedIds.length === 1) {
        await callFunction('sendNotificationToUser', {
          userId: selectedIds[0],
          title,
          body,
          matchId,
        });
        setMessage('Push sent only to the one selected user.');
        setMatchNotifyModal(null);
      } else {
        const result = await callFunction('sendNotificationToUsers', {
          userIds: selectedIds,
          title,
          body,
          matchId,
        });
        const sent = result?.data?.sent;
        setMessage(typeof sent === 'number' ? `Push sent only to ${sent} selected user(s).` : 'Notification request completed.');
        setMatchNotifyModal(null);
      }
    } catch (err) {
      console.error('send match notifications', err);
      setMessage(err?.message || err?.code || 'Failed to send notifications.');
    }
    setMatchNotifySending(false);
  };

  /** When requiredApprovals=2, need 1 (50%). When 4, need 2. Formula: ceil(required * 0.5), min 1. */
  const getMinApprovalsToShow = (req) => {
    const r = Math.max(1, parseInt(req, 10) || 1);
    return Math.max(1, Math.ceil(r * 0.5));
  };

  const handleApproveQuestion = async (q) => {
    if (!q) return;
    const approvedBy = Array.isArray(q.approvedBy) ? q.approvedBy : [];
    if (approvedBy.includes(user.uid)) {
      setMessage('You have already approved this question.');
      return;
    }
    setApprovingQid(q.id);
    try {
      const minRequired = getMinApprovalsToShow(cricketInsightsConfig.requiredApprovals ?? 1);
      await runTransaction(db, async (transaction) => {
        const ref = doc(db, 'cricket_questions', q.id);
        const snap = await transaction.get(ref);
        if (!snap.exists()) throw new Error('Question not found');
        const data = snap.data();
        const currentApprovedBy = Array.isArray(data.approvedBy) ? data.approvedBy : [];
        if (currentApprovedBy.includes(user.uid)) throw new Error('You have already approved this question.');
        const newApprovedBy = [...currentApprovedBy, user.uid];
        const isFullyApproved = newApprovedBy.length >= minRequired;
        transaction.update(ref, {
          approvedBy: newApprovedBy,
          ...(isFullyApproved
            ? { approved: true, status: 'approved', approvedAt: new Date().toISOString() }
            : {}),
        });
      });
      const newCount = approvedBy.length + 1;
      const isFullyApproved = newCount >= minRequired;
      setMessage(
        isFullyApproved
          ? 'Question approved. It is now visible for users to answer. Set the correct answer after the match completes.'
          : `Approved (${newCount}/${minRequired}). Need ${minRequired - newCount} more to show to users.`
      );
      if (isFullyApproved) {
        setPendingQuestions(prev => prev.filter(p => p.id !== q.id));
        setQuestionsAwaitingAnswer(prev => [...prev, { ...q, approved: true, status: 'approved', approvedAt: new Date().toISOString(), approvedBy: [...approvedBy, user.uid] }]);
      } else {
        setPendingQuestions(prev => prev.map(p => p.id === q.id ? { ...p, approvedBy: [...(p.approvedBy || []), user.uid] } : p));
      }
    } catch (err) {
      setMessage(err?.message === 'You have already approved this question.' ? err.message : 'Error approving: ' + (err.message || ''));
    }
    setApprovingQid(null);
  };

  const openAnswerModal = (q) => {
    setAnswerModalQuestion(q);
    if (q.type === 'yesno') setCorrectAnswerInput('Yes');
    else if (q.type === 'multiple' && (q.options || []).length > 0) setCorrectAnswerInput((q.options || [])[0] || '');
    else setCorrectAnswerInput('');
  };

  const openChangeAnswerModal = (q) => {
    setAnswerModalQuestion(q);
    const cur = String(q.correctAnswer ?? '').trim();
    if (cur) setCorrectAnswerInput(cur);
    else if (q.type === 'yesno') setCorrectAnswerInput('Yes');
    else if (q.type === 'multiple' && (q.options || []).length > 0) setCorrectAnswerInput((q.options || [])[0] || '');
    else setCorrectAnswerInput('');
  };

  const handleCorrectAnswerFormSubmit = async (e) => {
    e.preventDefault();
    const q = answerModalQuestion;
    if (!q || !correctAnswerInput.trim()) {
      setMessage('Please enter the correct answer');
      return;
    }
    const hasExisting =
      q.correctAnswer != null && String(q.correctAnswer).trim() !== '';
    if (hasExisting) {
      await handleUpdateCorrectAnswer();
    } else {
      await handleSetCorrectAnswerFirstTime();
    }
  };

  const handleSetCorrectAnswerFirstTime = async () => {
    const q = answerModalQuestion;
    if (!q || !correctAnswerInput.trim()) {
      setMessage('Please enter the correct answer');
      return;
    }
    setSubmittingAnswer(true);
    try {
      await updateDoc(doc(db, 'cricket_questions', q.id), {
        correctAnswer: correctAnswerInput.trim(),
        status: 'answered',
        answeredAt: new Date().toISOString(),
      });
      const answersSnap = await getDocs(
        query(collection(db, 'cricket_answers'), where('questionId', '==', q.id))
      );
      const correctAnswerNorm = String(correctAnswerInput).trim().toLowerCase();
      const penalty = getInsightWrongAnswerPenalty({ cricketInsightsConfig, pointRules });
      const winners = answersSnap.docs
        .map(d => ({ ...d.data(), id: d.id }))
        .filter(a => String(a.answer || '').trim().toLowerCase() === correctAnswerNorm);
      const losers = answersSnap.docs
        .map(d => ({ ...d.data(), id: d.id }))
        .filter(a => String(a.answer || '').trim().toLowerCase() !== correctAnswerNorm);
      const matchId = q.matchId;
      if (matchId) {
        const updates = {};
        winners.forEach(w => {
          if (w.userId) updates[`insightPointResults.${w.userId}`] = increment(1);
        });
        if (penalty > 0) {
          losers.forEach((w) => {
            if (w.userId) updates[`insightPointResults.${w.userId}`] = increment(-penalty);
          });
        }
        if (Object.keys(updates).length > 0) {
          await updateDoc(doc(db, 'matches', matchId), updates);
        }
      }
      const trimmed = correctAnswerInput.trim();
      let msg = `Correct answer set. ${winners.length} user(s) +1 pt${penalty > 0 ? `; ${losers.length} wrong answer(s) −${penalty} each` : ''}.`;
      if (!matchId) msg += ' Warning: no matchId — points were not saved on the match.';
      setMessage(msg);
      setAnswerModalQuestion(null);
      setCorrectAnswerInput('');
      setQuestionsAwaitingAnswer(prev => prev.filter(p => p.id !== q.id));
      setAnsweredInsightQuestions((prev) => [
        ...prev.filter((p) => p.id !== q.id),
        {
          ...q,
          correctAnswer: trimmed,
          status: 'answered',
          answeredAt: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      setMessage('Error setting answer: ' + (err.message || ''));
    }
    setSubmittingAnswer(false);
  };

  /** Adjust match insightPointResults when admin changes the official correct answer (+1 / −1 per affected user). */
  const handleUpdateCorrectAnswer = async () => {
    const q = answerModalQuestion;
    if (!q || !correctAnswerInput.trim()) {
      setMessage('Please enter the correct answer');
      return;
    }
    const oldAns = String(q.correctAnswer ?? '').trim();
    const newAns = correctAnswerInput.trim();
    if (oldAns === newAns) {
      setMessage('The correct answer is unchanged.');
      setAnswerModalQuestion(null);
      return;
    }
    if (
      !window.confirm(
        'Update the correct answer? Match insight points will adjust (+1 / −penalty for wrong) for each player based on the new official answer.'
      )
    ) {
      return;
    }
    setSubmittingAnswer(true);
    try {
      const answersSnap = await getDocs(
        query(collection(db, 'cricket_answers'), where('questionId', '==', q.id))
      );
      const oldNorm = oldAns.toLowerCase();
      const newNorm = newAns.toLowerCase();
      const matchId = q.matchId;
      const penalty = getInsightWrongAnswerPenalty({ cricketInsightsConfig, pointRules });
      const updates = {};
      answersSnap.docs.forEach((d) => {
        const a = d.data();
        const uid = a.userId;
        if (!uid) return;
        const ansNorm = String(a.answer || '').trim().toLowerCase();
        const wasRight = ansNorm === oldNorm;
        const nowRight = ansNorm === newNorm;
        const delta = insightPointDeltaOnAnswerChange(wasRight, nowRight, penalty);
        if (delta !== 0) updates[`insightPointResults.${uid}`] = increment(delta);
      });
      await updateDoc(doc(db, 'cricket_questions', q.id), {
        correctAnswer: newAns,
        correctAnswerUpdatedAt: new Date().toISOString(),
      });
      if (matchId && Object.keys(updates).length > 0) {
        await updateDoc(doc(db, 'matches', matchId), updates);
      }
      const n = Object.keys(updates).length;
      setAnswerModalQuestion(null);
      setCorrectAnswerInput('');
      setMessage(
        n > 0
          ? `Correct answer updated. Adjusted insight points for ${n} user(s) on the match.`
          : 'Correct answer updated. No insight point changes (no answers matched differently).'
      );
      setAnsweredInsightQuestions((prev) =>
        prev.map((p) =>
          p.id === q.id ? { ...p, correctAnswer: newAns, correctAnswerUpdatedAt: new Date().toISOString() } : p
        )
      );
    } catch (err) {
      setMessage('Error updating answer: ' + (err.message || ''));
    }
    setSubmittingAnswer(false);
  };

  const handleRejectQuestion = async (q) => {
    if (!confirm(`Reject question: "${(q.question || '').slice(0, 50)}..."?`)) return;
    setRejectingQid(q.id);
    try {
      await updateDoc(doc(db, 'cricket_questions', q.id), {
        status: 'rejected',
        rejectedAt: new Date().toISOString(),
      });
      setMessage('Question rejected');
      setPendingQuestions(prev => prev.filter(p => p.id !== q.id));
    } catch (err) {
      setMessage('Error rejecting: ' + (err.message || ''));
    }
    setRejectingQid(null);
  };

  const handleRemoveQuestion = async (q) => {
    if (!confirm(`Permanently remove question: "${(q.question || '').slice(0, 50)}..."? This cannot be undone.`)) return;
    setRemovingQid(q.id);
    try {
      await deleteDoc(doc(db, 'cricket_questions', q.id));
      setMessage('Question removed.');
      setPendingQuestions(prev => prev.filter(p => p.id !== q.id));
      setQuestionsAwaitingAnswer(prev => prev.filter(p => p.id !== q.id));
      setAnsweredInsightQuestions(prev => prev.filter(p => p.id !== q.id));
    } catch (err) {
      setMessage('Error removing: ' + (err.message || ''));
    }
    setRemovingQid(null);
  };

  const handleToggleAnswersDisabled = async (q, nextDisabled) => {
    if (!q?.id) return;
    setTogglingAnswersQid(q.id);
    try {
      await updateDoc(doc(db, 'cricket_questions', q.id), {
        answersDisabled: nextDisabled,
        answersDisabledAt: nextDisabled ? new Date().toISOString() : deleteField(),
        answersDisabledBy: nextDisabled ? user.uid : deleteField(),
      });
      setMessage(nextDisabled ? 'Answers disabled for this question.' : 'Answers enabled again.');
      setQuestionsAwaitingAnswer(prev =>
        prev.map(p =>
          p.id === q.id
            ? {
                ...p,
                answersDisabled: nextDisabled,
                answersDisabledAt: nextDisabled ? new Date().toISOString() : null,
                answersDisabledBy: nextDisabled ? user.uid : null,
              }
            : p
        )
      );
    } catch (err) {
      setMessage('Error updating question: ' + (err.message || ''));
    }
    setTogglingAnswersQid(null);
  };

  const handleAddTeam = async (e) => {
    e.preventDefault();
    if (!newTeam.trim()) return;
    const nameUpper = newTeam.trim().toUpperCase();
    const code = (newTeamCode || '').trim().toUpperCase();
    if (teams.some(t => (t.name || '').toUpperCase() === nameUpper)) {
      setMessage('Team already exists');
      return;
    }
    if (code && teams.some(t => (t.code || '').toUpperCase() === code)) {
      setMessage('Team code already exists');
      return;
    }
    // Include any player typed but not yet added
    let playersToSave = [...newTeamPlayers];
    if (newPlayerInput.trim()) {
      playersToSave = setPlayerRole(
        [...playersToSave, { name: newPlayerInput.trim(), active: newPlayerActive, type: newPlayerType, role: newPlayerRole }],
        playersToSave.length,
        newPlayerRole
      );
    }
    try {
      await addDoc(collection(db, 'teams'), {
        name: nameUpper,
        code: code || '',
        players: playersToSave,
        createdBy: user.uid,
        createdAt: new Date().toISOString(),
      });
      setNewTeam('');
      setNewTeamCode('');
      setNewTeamPlayers([]);
      setNewPlayerInput('');
      setMessage('Team added successfully');
      fetchData();
    } catch (err) {
      setMessage('Error: ' + err.message);
    }
  };

  const handleDeleteTeam = async (teamId) => {
    if (!confirm('Are you sure you want to remove this team?')) return;
    try {
      await deleteDoc(doc(db, 'teams', teamId));
      setEditingTeam(null);
      setExpandedTeamId(null);
      setMessage('Team removed successfully');
      fetchData();
    } catch (err) {
      setMessage('Error: ' + err.message);
    }
  };

  const handleEditTeam = (team) => {
    setEditingTeam({
      id: team.id,
      name: team.name,
      code: team.code || '',
      players: normalizePlayers(team.players || []),
    });
    setEditPlayerInput('');
  };

  const addPlayerToEdit = () => {
    const val = editPlayerInput.trim();
    if (val && editingTeam) {
      const newPlayers = [...(editingTeam.players || []), { name: val, active: editPlayerActive, type: editPlayerType, role: editPlayerRole }];
      setEditingTeam(prev => ({ ...prev, players: setPlayerRole(newPlayers, newPlayers.length - 1, editPlayerRole) }));
      setEditPlayerInput('');
    }
  };

  const handleImportPlayersEdit = (replace = true) => {
    setImportError('');
    const result = parseImportedPlayers(importJsonText);
    if (result.error) {
      setImportError(result.error);
      return;
    }
    let players = replace ? result.players : [...(editingTeam?.players || []), ...result.players];
    for (let i = 0; i < players.length; i++) {
      if (players[i].role === 'captain' || players[i].role === 'viceCaptain') {
        players = setPlayerRole(players, i, players[i].role);
      }
    }
    setEditingTeam(prev => ({ ...prev, players }));
    setImportJsonText('');
    setMessage(`Imported ${result.players.length} players. Click Save to persist.`);
  };

  const handleImportMatches = async () => {
    setImportMatchError('');
    const result = parseImportedMatches(importMatchJsonText);
    if (result.error) {
      setImportMatchError(result.error);
      return;
    }
    setImportMatchLoading(true);
    try {
      const createdAt = new Date().toISOString();
      const BATCH = 450;
      let batch = writeBatch(db);
      let n = 0;
      for (const m of result.matches) {
        const ref = doc(collection(db, 'matches'));
        batch.set(
          ref,
          withPredictionCutoffAt({
            ...m,
            createdBy: user.uid,
            createdAt,
          })
        );
        n += 1;
        if (n >= BATCH) {
          await batch.commit();
          batch = writeBatch(db);
          n = 0;
        }
      }
      if (n > 0) await batch.commit();
      setImportMatchJsonText('');
      setMessage(`Imported ${result.matches.length} matches successfully`);
      fetchData();
    } catch (err) {
      setImportMatchError('Failed to import: ' + (err.message || ''));
    }
    setImportMatchLoading(false);
  };

  const handleUpdateTeam = async (e) => {
    e.preventDefault();
    if (!editingTeam?.name?.trim()) return;
    let playersToSave = [...(editingTeam.players || [])];
    if (editPlayerInput.trim()) {
      playersToSave = setPlayerRole(
        [...playersToSave, { name: editPlayerInput.trim(), active: editPlayerActive, type: editPlayerType, role: editPlayerRole }],
        playersToSave.length,
        editPlayerRole
      );
    }
    try {
      await updateDoc(doc(db, 'teams', editingTeam.id), {
        name: editingTeam.name.trim().toUpperCase(),
        code: (editingTeam.code || '').trim().toUpperCase(),
        players: playersToSave,
      });
      setEditingTeam(null);
      setMessage('Team updated successfully');
      fetchData();
    } catch (err) {
      setMessage('Error: ' + err.message);
    }
  };

  const handleAddRule = async (e) => {
    e.preventDefault();
    const key = (newRuleKey || '').trim();
    const value = (newRuleValue || '').trim();
    if (!key && !value) return;
    const position = parseInt(String(newRulePosition || '0'), 10);
    try {
      const docRef = await addDoc(collection(db, 'rules'), {
        ...(key ? { key } : {}),
        content: value || key,
        position: isNaN(position) ? 0 : position,
        createdBy: user.uid,
        createdAt: new Date().toISOString(),
      });
      setRules(prev => [...prev, { id: docRef.id, key: key || null, content: value || key, position: isNaN(position) ? 0 : position }]);
      setNewRuleKey('');
      setNewRuleValue('');
      setNewRulePosition('');
      setMessage('Rule added successfully');
    } catch (err) {
      setMessage('Error: ' + err.message);
    }
  };

  const handleEditRule = (rule) => {
    setEditingRule({
      id: rule.id,
      key: rule.key || '',
      content: rule.content || '',
      position: rule.position ?? 0,
    });
  };

  const handleUpdateRule = async (e) => {
    e.preventDefault();
    if (!editingRule?.id) return;
    const key = (editingRule.key || '').trim();
    const value = (editingRule.content || '').trim();
    if (!key && !value) return;
    const position = parseInt(String(editingRule.position ?? '0'), 10);
    try {
      await updateDoc(doc(db, 'rules', editingRule.id), {
        key: key || null,
        content: value || key,
        position: isNaN(position) ? 0 : position,
        updatedAt: new Date().toISOString(),
      });
      setRules(prev => prev.map(r => r.id === editingRule.id
        ? { ...r, key: key || null, content: value || key, position: isNaN(position) ? 0 : position }
        : r));
      setEditingRule(null);
      setMessage('Rule updated successfully');
    } catch (err) {
      setMessage('Error: ' + err.message);
    }
  };

  const handleRemoveRule = async (rule) => {
    if (!rule?.id) return;
    if (rule.id === 'pointRules') return;
    const display = rule.key ? `${rule.key}: ${(rule.content || '').slice(0, 30)}` : (rule.content || '').slice(0, 50);
    if (!confirm(`Remove rule: "${display}${display.length >= 50 ? '...' : ''}"?`)) return;
    setRemovingRuleId(rule.id);
    try {
      await deleteDoc(doc(db, 'rules', rule.id));
      setRules(prev => prev.filter(r => r.id !== rule.id));
      setMessage('Rule removed successfully');
    } catch (err) {
      setMessage('Error: ' + err.message);
    }
    setRemovingRuleId(null);
  };

  const handleAddMatch = async (e) => {
    e.preventDefault();
    if (!matchForm.matchNumber?.toString().trim() || !matchForm.team1 || !matchForm.team2 || !matchForm.date) {
      setMessage('Please fill all match fields including Match ID');
      return;
    }
    if (matchForm.team1 === matchForm.team2) {
      setMessage('Please select two different teams');
      return;
    }
    const threshold = matchForm.thresholdTime || '18:00';
    const matchTime = matchForm.time || '19:00';
    if (threshold > matchTime) {
      setMessage('Predict-before time must not be later than match time');
      return;
    }
    const matchNumber = String(matchForm.matchNumber).trim();
    const matchNameTrim = (matchForm.matchName || '').trim();
    const stadium = (matchForm.stadium || '').trim();
    const city = (matchForm.city || '').trim();
    const crowd = matchForm.crowdPredictionVisibility;
    const multStr = (matchForm.pointsMultiplier ?? '').toString().trim();
    if (multStr !== '') {
      const multNum = parseFloat(multStr.replace(',', '.'));
      if (!Number.isFinite(multNum) || multNum <= 0) {
        setMessage('Winner points multiplier must be a positive number, or leave blank for 1×.');
        return;
      }
    }
    try {
      const multNum =
        multStr === '' ? null : parseFloat(multStr.replace(',', '.'));
      const multDoc =
        multNum != null && Number.isFinite(multNum) && multNum > 0 && multNum !== 1
          ? { pointsMultiplier: multNum }
          : {};
      await addDoc(
        collection(db, 'matches'),
        withPredictionCutoffAt({
          matchNumber,
          team1: matchForm.team1,
          team2: matchForm.team2,
          date: matchForm.date,
          time: matchForm.time || '19:00',
          thresholdTime: matchForm.thresholdTime || '18:00',
          status: 'open',
          ...(matchNameTrim ? { matchName: matchNameTrim } : {}),
          ...multDoc,
          ...(stadium ? { stadium } : {}),
          ...(city ? { city } : {}),
          ...(crowd === 'always' || crowd === 'afterCutoff' ? { crowdPredictionVisibility: crowd } : {}),
          createdBy: user.uid,
          createdAt: new Date().toISOString(),
        })
      );
      setMatchForm(prev => ({
        matchName: '',
        matchNumber: '',
        team1: '',
        team2: '',
        date: prev.date,
        time: '19:00',
        thresholdTime: '18:00',
        stadium: '',
        city: '',
        crowdPredictionVisibility: 'inherit',
        pointsMultiplier: '',
      }));
      setMessage('Match added successfully');
      fetchData();
    } catch (err) {
      setMessage('Error: ' + err.message);
    }
  };

  const handleEditMatch = (match) => {
    let time = match.time || '19:00';
    if (match.slot && !match.time && !/^\d{1,2}:\d{2}$/.test(match.slot)) {
      const slotMap = { Afternoon: '14:00', Evening: '19:00', Night: '21:00' };
      time = slotMap[match.slot] || '19:00';
    }
    const thresholdTime = match.thresholdTime || '18:00';
    const cv = (match.crowdPredictionVisibility || '').toString().trim().toLowerCase();
    const crowdPredictionVisibility =
      cv === 'always' ? 'always' : cv === 'aftercutoff' ? 'afterCutoff' : 'inherit';
    setEditingMatch({
      id: match.id,
      matchName: match.matchName || '',
      matchNumber: match.matchNumber || '',
      team1: match.team1 || '',
      team2: match.team2 || '',
      date: match.date || '',
      time,
      thresholdTime,
      status: match.status || 'open',
      winner: match.winner || '',
      stadium: match.stadium || '',
      city: match.city || '',
      crowdPredictionVisibility,
      pointsMultiplier:
        match.pointsMultiplier != null && String(match.pointsMultiplier).trim() !== ''
          ? String(match.pointsMultiplier)
          : '',
    });
  };

  const handleUpdateMatch = async (e) => {
    e.preventDefault();
    if (!editingMatch?.team1 || !editingMatch?.team2 || !editingMatch?.date) {
      setMessage('Please fill all match fields');
      return;
    }
    if (editingMatch.team1 === editingMatch.team2) {
      setMessage('Please select two different teams');
      return;
    }
    const threshold = editingMatch.thresholdTime || '18:00';
    const matchTime = editingMatch.time || '19:00';
    if (threshold > matchTime) {
      setMessage('Predict-before time must not be later than match time');
      return;
    }
    const statusLc = (editingMatch.status || '').toLowerCase();
    const winnerTrim = (editingMatch.winner || '').trim();
    if (statusLc === 'completed' && !winnerTrim) {
      setMessage('When status is completed, choose a result: winner, draw, or cancelled.');
      return;
    }
    try {
      const est = (editingMatch.stadium || '').trim();
      const ecity = (editingMatch.city || '').trim();
      const matchNameTrim = (editingMatch.matchName || '').trim();
      const namePatch = matchNameTrim ? { matchName: matchNameTrim } : { matchName: deleteField() };
      const multStr = (editingMatch.pointsMultiplier ?? '').toString().trim();
      let multPatch;
      if (multStr === '') {
        multPatch = { pointsMultiplier: deleteField() };
      } else {
        const multNum = parseFloat(multStr.replace(',', '.'));
        if (!Number.isFinite(multNum) || multNum <= 0) {
          setMessage('Winner points multiplier must be a positive number, or leave blank for 1×.');
          return;
        }
        multPatch =
          multNum === 1 ? { pointsMultiplier: deleteField() } : { pointsMultiplier: multNum };
      }
      const crowd = editingMatch.crowdPredictionVisibility;
      const crowdPatch =
        crowd === 'inherit'
          ? { crowdPredictionVisibility: deleteField() }
          : { crowdPredictionVisibility: crowd === 'afterCutoff' ? 'afterCutoff' : 'always' };
      const participatingUsers = (allUsers || []).filter((u) => !u.isAdmin && u.isAdmin !== 'true');
      const pointResultsForNoScore =
        statusLc === 'completed' && isDrawOrCancelledWinner(editingMatch.winner)
          ? Object.fromEntries(participatingUsers.map((u) => [u.id, 0]))
          : undefined;
      await updateDoc(
        doc(db, 'matches', editingMatch.id),
        withPredictionCutoffAt({
          matchNumber: (editingMatch.matchNumber || '').toString().trim(),
          team1: editingMatch.team1,
          team2: editingMatch.team2,
          date: editingMatch.date,
          time: editingMatch.time,
          thresholdTime: editingMatch.thresholdTime,
          status: editingMatch.status || 'open',
          winner: editingMatch.winner || null,
          stadium: est || null,
          city: ecity || null,
          ...namePatch,
          ...multPatch,
          ...(pointResultsForNoScore ? { pointResults: pointResultsForNoScore } : {}),
          ...crowdPatch,
        })
      );
      setEditingMatch(null);
      setMessage('Match updated successfully');
      fetchData();
    } catch (err) {
      setMessage('Error: ' + err.message);
    }
  };

  const handleCalculatePoints = async (match) => {
    if (!match.winner?.trim()) {
      setMessage('Set winner first before calculating points.');
      return;
    }
    if (isDrawOrCancelledWinner(match.winner)) {
      setMessage('Draw and cancelled matches do not use pool scoring. Saving the match as draw/cancelled already records 0 points for everyone.');
      return;
    }
    const participatingUsers = (allUsers || []).filter(u => !u.isAdmin && u.isAdmin !== 'true');
    if (!participatingUsers.length) {
      setMessage(usersFetchError
        ? `Could not load users: ${usersFetchError}. Check Firestore rules allow reading the users collection.`
        : 'No participating users found. Admins are excluded. Ensure there are non-admin users in the users collection.');
      setCalculatingMatchId(null);
      return;
    }
    setCalculatingMatchId(match.id);
    try {
      const predsSnap = await getDocs(
        query(collection(db, 'predictions'), where('matchId', '==', match.id))
      );
      const matchPreds = predsSnap.docs.map(d => {
        const data = d.data();
        const uid = data.userId ?? data.uid ?? d.id?.split('_')?.[0];
        return { userId: uid, predictedWinner: data.predictedWinner };
      }).filter(p => p.userId);
      const { userPoints, summary } = calculateMatchPoints(match, participatingUsers, matchPreds, pointRules);
      const pointResults = {};
      Object.entries(userPoints || {}).forEach(([uid, pts]) => {
        pointResults[uid] = Math.round(pts * 100) / 100;
      });
      if (Object.keys(pointResults).length === 0) {
        setMessage('No points to save. Check that users exist and predictions use the same team names as the match winner.');
        setCalculatingMatchId(null);
        return;
      }
      await updateDoc(doc(db, 'matches', match.id), { pointResults });
      const s = summary || {};
      let notifyNote = '';
      if (programConfig.notifyOnPointsCalculated !== false) {
        try {
          const res = await callFunction('notifyPointsCalculated', { matchId: String(match.id) });
          const sent = res?.data?.sent ?? 0;
          notifyNote = ` Push notifications sent: ${sent}.`;
        } catch (notifyErr) {
          const msg = notifyErr?.message || notifyErr?.code || 'failed';
          console.warn('notifyPointsCalculated', notifyErr);
          notifyNote = ` Notifications not sent (${msg}). Points were saved.`;
        }
      } else {
        notifyNote = ' Push notifications skipped (disabled in Program Config).';
      }
      const multNote =
        s.pointsMultiplier > 1
          ? ` Winner share ×${s.pointsMultiplier} (${s.basePointsPerWinner ?? '—'} each base → ${s.pointsPerWinner ?? '—'}).`
          : '';
      setMessage(
        `Points calculated and saved. Winners: ${s.winners ?? 0}, Wrong: ${s.wrong ?? 0}, Not participated: ${s.notParticipated ?? 0}.${multNote}${notifyNote}`
      );
      fetchData();
    } catch (err) {
      setMessage('Error: ' + err.message);
    }
    setCalculatingMatchId(null);
  };

  const handleDeleteMatch = async (matchId) => {
    if (!confirm('Are you sure you want to remove this match?')) return;
    try {
      await deleteDoc(doc(db, 'matches', matchId));
      setEditingMatch(null);
      setSelectedMatchIds(prev => prev.filter(id => id !== matchId));
      setMessage('Match removed successfully');
      fetchData();
    } catch (err) {
      setMessage('Error: ' + err.message);
    }
  };

  const toggleMatchSelection = (matchId) => {
    setSelectedMatchIds(prev =>
      prev.includes(matchId) ? prev.filter(id => id !== matchId) : [...prev, matchId]
    );
  };

  const selectAllMatches = () => setSelectedMatchIds(matches.map(m => m.id));
  const deselectAllMatches = () => setSelectedMatchIds([]);

  const handleBulkDeleteMatches = async () => {
    if (selectedMatchIds.length === 0) {
      setMessage('Select at least one match to delete.');
      return;
    }
    if (!confirm(`Delete ${selectedMatchIds.length} selected match(es)? This cannot be undone.`)) return;
    setBulkDeleteLoading(true);
    try {
      for (const matchId of selectedMatchIds) {
        await deleteDoc(doc(db, 'matches', matchId));
      }
      setEditingMatch(null);
      setSelectedMatchIds([]);
      setMessage(`Deleted ${selectedMatchIds.length} match(es) successfully`);
      fetchData();
    } catch (err) {
      setMessage('Error deleting matches: ' + (err.message || ''));
    }
    setBulkDeleteLoading(false);
  };

  const handleExportPointsExcel = async () => {
    const from = (pointsExportFrom || '').trim();
    const to = (pointsExportTo || '').trim();
    if (!from || !to) {
      setMessage('Select both start and end dates.');
      return;
    }
    if (from > to) {
      setMessage('Start date must be on or before end date.');
      return;
    }
    setPointsExportLoading(true);
    try {
      const [matchesSnap, usersSnap, predsSnap] = await Promise.all([
        getDocs(collection(db, 'matches')),
        getDocs(collection(db, 'users')),
        getDocs(collection(db, 'predictions')),
      ]);
      const usersById = new Map();
      usersSnap.docs.forEach((d) => {
        usersById.set(d.id, { id: d.id, ...d.data() });
      });
      const predKey = (mid, uid) => `${String(mid)}|${String(uid)}`;
      const predMap = new Map();
      predsSnap.docs.forEach((d) => {
        const x = d.data();
        const mid = x.matchId ?? x.matchID;
        const uid = x.userId ?? x.uid;
        if (mid == null || uid == null) return;
        predMap.set(predKey(mid, uid), (x.predictedWinner || '').trim());
      });
      const rows = [];
      /** @type {Map<string, { sum: number, matches: number }>} */
      const leaderboardTotals = new Map();
      matchesSnap.docs.forEach((d) => {
        const match = { id: d.id, ...d.data() };
        const date = (match.date || '').trim();
        if (!date || date < from || date > to) return;
        const pr = match.pointResults;
        if (!pr || typeof pr !== 'object') return;
        Object.entries(pr).forEach(([uid, pts]) => {
          const u = usersById.get(uid);
          if (u?.isAdmin || u?.isAdmin === 'true') return;
          const raw = typeof pts === 'number' ? pts : Number(pts);
          const n = Number.isFinite(raw) ? raw : 0;
          const predicted = predMap.get(predKey(match.id, uid)) ?? '';
          rows.push({
            'Match date': date,
            'Username': (u?.username || '').trim() || (u?.email || '').trim() || uid,
            'Team A': match.team1 || '',
            'Team B': match.team2 || '',
            'Predicted winner': predicted,
            'Winner': getMatchResultLabel(match, getTeamCode, teams),
            'Points': n,
          });
          const agg = leaderboardTotals.get(uid) || { sum: 0, matches: 0 };
          agg.sum += n;
          agg.matches += 1;
          leaderboardTotals.set(uid, agg);
        });
      });
      rows.sort((a, b) => {
        const c = a['Match date'].localeCompare(b['Match date']);
        if (c !== 0) return c;
        return a.Username.localeCompare(b.Username);
      });
      if (rows.length === 0) {
        setMessage('No point data in that date range. Matches need calculated points and must fall within the range.');
        setPointsExportLoading(false);
        return;
      }
      const leaderboardRows = Array.from(leaderboardTotals.entries()).map(([uid, { sum, matches: matchCount }]) => {
        const u = usersById.get(uid);
        return {
          Rank: 0,
          Username: (u?.username || '').trim() || (u?.email || '').trim() || uid,
          'Total points': to2Decimals(sum),
          'Matches counted': matchCount,
        };
      });
      // Same order as Dashboard leaderboard: points desc, then username; dense rank (ties share rank, next rank +1 only when points drop).
      leaderboardRows.sort((a, b) => {
        const pb = Number(b['Total points']);
        const pa = Number(a['Total points']);
        if (pb !== pa) return pb - pa;
        return (a.Username || '').localeCompare(b.Username || '', undefined, { sensitivity: 'base' });
      });
      let lbRank = 1;
      for (let i = 0; i < leaderboardRows.length; i++) {
        if (i > 0 && Number(leaderboardRows[i - 1]['Total points']) > Number(leaderboardRows[i]['Total points'])) {
          lbRank += 1;
        }
        leaderboardRows[i].Rank = lbRank;
      }
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Points');
      const wsLb = XLSX.utils.json_to_sheet(leaderboardRows);
      XLSX.utils.book_append_sheet(wb, wsLb, 'Leaderboard');
      const fname = `points-${from}-to-${to}.xlsx`;
      XLSX.writeFile(wb, fname);
      setMessage(`Exported ${rows.length} row(s) and leaderboard (${leaderboardRows.length} users) to ${fname}`);
    } catch (err) {
      setMessage('Export failed: ' + (err.message || 'unknown error'));
    }
    setPointsExportLoading(false);
  };

  const handleRemoveUser = async (targetUser) => {
    if (!confirm(`Remove user "${toInitCap(targetUser.username || targetUser.email || targetUser.id)}"? They will not be able to login. (Firebase Auth account remains - remove from Firebase Console if needed)`)) return;
    setRemovingUserId(targetUser.id);
    try {
      const usernameKey = (targetUser.username || '').toLowerCase().trim().replace(/\s+/g, '_');
      await deleteDoc(doc(db, 'users', targetUser.id));
      if (usernameKey) {
        try {
          await deleteDoc(doc(db, 'usernameLookup', usernameKey));
        } catch {
          // usernameLookup may not exist
        }
      }
      setMessage('User removed successfully');
      fetchData();
    } catch (err) {
      setMessage('Error: ' + err.message);
    }
    setRemovingUserId(null);
  };

  const handleApproveUser = async (targetUser) => {
    if (!targetUser?.id) return;
    setApprovingUserId(targetUser.id);
    try {
      await updateDoc(doc(db, 'users', targetUser.id), {
        predictionApproved: true,
        predictionApprovedAt: new Date().toISOString(),
      });
      setMessage('User approved for predictions.');
      setAllUsers(prev => prev.map(u => u.id === targetUser.id ? { ...u, predictionApproved: true } : u));
    } catch (err) {
      setMessage('Error: ' + err.message);
    }
    setApprovingUserId(null);
  };

  const handleAdminSetUserPasswordSubmit = async (e) => {
    e.preventDefault();
    if (!setPasswordUser?.id) return;
    setMessage('');
    if (adminSetPasswordNew !== adminSetPasswordConfirm) {
      setMessage('Passwords do not match.');
      return;
    }
    if (adminSetPasswordNew.length < 6) {
      setMessage('Password must be at least 6 characters.');
      return;
    }
    setAdminSetPasswordLoading(true);
    try {
      const res = await callFunction('adminSetUserPassword', {
        userId: setPasswordUser.id,
        newPassword: adminSetPasswordNew,
      });
      if (res?.data?.success) {
        setMessage(`Password updated for ${toInitCap(setPasswordUser.username || setPasswordUser.email || 'user')}. Tell them to sign in with the new password.`);
        setSetPasswordUser(null);
        setAdminSetPasswordNew('');
        setAdminSetPasswordConfirm('');
      }
    } catch (err) {
      const raw = err?.message || err?.code || 'Failed to set password';
      setMessage('Error: ' + raw);
    }
    setAdminSetPasswordLoading(false);
  };

  const handleSaveProgramConfig = async (e) => {
    e.preventDefault();
    try {
      const notParticipated = Math.abs(Number(pointRules.notParticipatedPoints) || 7);
      const wrongPrediction = Math.abs(Number(pointRules.wrongPredictionPoints) || 5);
      const max = Math.max(1, Math.min(100, parseInt(passwordPolicy.maxPasswordChanges, 10) || 2));
      const deadline = (passwordPolicy.surrenderDeadline || '').trim();
      const maxPerUser = Math.max(1, Math.min(10, parseInt(cricketInsightsConfig.maxQuestionsPerUserPerMatch, 10) || 1));
      const maxPerMatch = Math.max(1, Math.min(20, parseInt(cricketInsightsConfig.maxQuestionsPerMatch, 10) || 5));
      const insightPenalty = Math.max(
        0,
        to2Decimals(Math.abs(Number(cricketInsightsConfig.insightWrongAnswerPenalty ?? 0.25)))
      );
      const matchStartDate = (programConfig.matchStartDate || '').trim();
      const scheduleInterval = Math.max(1, Math.min(60, parseInt(programConfig.scheduleIntervalMinutes, 10) || 10));
      const loserPercent = Math.max(0, Math.min(50, parseInt(programConfig.loserPercent, 10) || 25));
      const crowdPredictionVisibility =
        programConfig.crowdPredictionVisibility === 'afterCutoff' ? 'afterCutoff' : 'always';
      const rawCrowdDelay = programConfig.crowdPredictionMinutesAfterCutoff;
      const crowdPredictionMinutesAfterCutoff =
        rawCrowdDelay != null && rawCrowdDelay !== '' && Number.isFinite(Number(rawCrowdDelay))
          ? Math.max(0, Math.min(24 * 60, Number(rawCrowdDelay)))
          : 10;
      const notifyOnPointsCalculated = programConfig.notifyOnPointsCalculated !== false;
      await Promise.all([
        setDoc(doc(db, 'rules', 'pointRules'), {
          notParticipatedPoints: notParticipated,
          wrongPredictionPoints: wrongPrediction,
          updatedAt: new Date().toISOString(),
        }),
        setDoc(doc(db, 'settings', 'programConfig'), {
          matchStartDate: matchStartDate || null,
          scheduleIntervalMinutes: scheduleInterval,
          loserPercent: loserPercent,
          crowdPredictionVisibility,
          crowdPredictionMinutesAfterCutoff,
          notifyOnPointsCalculated,
          updatedAt: new Date().toISOString(),
        }),
        setDoc(doc(db, 'settings', 'passwordPolicy'), {
          maxPasswordChanges: max,
          surrenderDeadline: deadline || null,
          updatedAt: new Date().toISOString(),
        }),
        setDoc(doc(db, 'settings', 'cricketInsights'), {
          enabled: cricketInsightsConfig.enabled,
          maxQuestionsPerUserPerMatch: maxPerUser,
          maxQuestionsPerMatch: maxPerMatch,
          insightApproverIds: cricketInsightsConfig.insightApproverIds || [],
          requiredApprovals: Math.max(1, Math.min(10, parseInt(cricketInsightsConfig.requiredApprovals, 10) || 1)),
          insightWrongAnswerPenalty: insightPenalty,
          allowInsightQuestionsAfterPredictionCutoff:
            cricketInsightsConfig.allowInsightQuestionsAfterPredictionCutoff === true,
          allowInsightAnswersAfterPredictionCutoff:
            cricketInsightsConfig.allowInsightAnswersAfterPredictionCutoff === true,
          updatedAt: new Date().toISOString(),
        }),
      ]);
      const approverIds = cricketInsightsConfig.insightApproverIds || [];
      const approverIdSet = new Set(approverIds);
      for (const uid of approverIds) {
        await setDoc(doc(db, 'insight_approvers', uid), { addedAt: new Date().toISOString() });
      }
      const existingSnap = await getDocs(collection(db, 'insight_approvers'));
      for (const d of existingSnap.docs) {
        if (!approverIdSet.has(d.id)) {
          try {
            await deleteDoc(doc(db, 'insight_approvers', d.id));
          } catch {
            // ignore
          }
        }
      }
      setPointRules(prev => ({ ...prev, notParticipatedPoints: notParticipated, wrongPredictionPoints: wrongPrediction }));
      setProgramConfig(prev => ({
        ...prev,
        matchStartDate,
        scheduleIntervalMinutes: scheduleInterval,
        loserPercent,
        crowdPredictionVisibility,
        crowdPredictionMinutesAfterCutoff,
        notifyOnPointsCalculated,
      }));
      setPasswordPolicy(prev => ({ ...prev, maxPasswordChanges: max, surrenderDeadline: deadline }));
      setCricketInsightsConfig((prev) => ({
        ...prev,
        enabled: cricketInsightsConfig.enabled,
        maxQuestionsPerUserPerMatch: maxPerUser,
        maxQuestionsPerMatch: maxPerMatch,
        insightWrongAnswerPenalty: insightPenalty,
        allowInsightQuestionsAfterPredictionCutoff:
          cricketInsightsConfig.allowInsightQuestionsAfterPredictionCutoff === true,
        allowInsightAnswersAfterPredictionCutoff:
          cricketInsightsConfig.allowInsightAnswersAfterPredictionCutoff === true,
      }));
      setMessage('Program config saved successfully');
    } catch (err) {
      setMessage('Error: ' + (err.message || 'Save failed'));
    }
  };

  return (
    <div className="app-layout">
      <Sidebar admin userProfile={userProfile} user={user} onLogout={logout} activeSection={activeSection} onSectionChange={setActiveSection} isMobileOpen={mobileMenuOpen} onMobileClose={() => setMobileMenuOpen(false)} />

      <main className="app-main">
        <header className="dashboard-header">
          <button type="button" className="hamburger-btn" onClick={() => setMobileMenuOpen(true)} aria-label="Open menu">☰</button>
          <h1>Admin Panel</h1>
        </header>

        {loading ? (
          <p>Loading...</p>
        ) : (
        <div className="admin-content">
          {message && (
            <div className={`alert alert-toast ${message.startsWith('Error') ? 'alert-error' : 'alert-success'}`}>
              {message}
            </div>
          )}

          {activeSection === 'teams' && (
          <section id="section-teams" className="admin-section">
            <h2>Add Team</h2>
            <form onSubmit={handleAddTeam} className="team-form">
              <input
                type="text"
                value={newTeam}
                onChange={(e) => setNewTeam(e.target.value)}
                placeholder="Team name (e.g., Mumbai Indians)"
                required
              />
              <input
                type="text"
                value={newTeamCode}
                onChange={(e) => setNewTeamCode(e.target.value)}
                placeholder="Code (e.g., MI)"
                maxLength={10}
              />
              <div className="form-group-players">
                <label>Players (optional) — type, Active/Inactive, Captain/Vice Captain</label>
                <div className="player-add-row">
                  <input
                    type="text"
                    value={newPlayerInput}
                    onChange={(e) => setNewPlayerInput(e.target.value)}
                    placeholder="Player name"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (newPlayerInput.trim()) {
                          const newPlayers = [...newTeamPlayers, { name: newPlayerInput.trim(), active: newPlayerActive, type: newPlayerType, role: newPlayerRole }];
                          setNewTeamPlayers(setPlayerRole(newPlayers, newTeamPlayers.length, newPlayerRole));
                          setNewPlayerInput('');
                        }
                      }
                    }}
                  />
                  <select
                    value={newPlayerType}
                    onChange={(e) => setNewPlayerType(e.target.value)}
                    className="player-type-select"
                    title="Player type"
                  >
                    {PLAYER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <select
                    value={newPlayerActive ? 'active' : 'inactive'}
                    onChange={(e) => setNewPlayerActive(e.target.value === 'active')}
                    className="player-active-select"
                    title="Active = playing on match day"
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                  <select
                    value={newPlayerRole}
                    onChange={(e) => setNewPlayerRole(e.target.value)}
                    className="player-role-select"
                    title="Captain / Vice Captain"
                  >
                    {PLAYER_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      if (newPlayerInput.trim()) {
                        const newPlayers = [...newTeamPlayers, { name: newPlayerInput.trim(), active: newPlayerActive, type: newPlayerType, role: newPlayerRole }];
                        setNewTeamPlayers(setPlayerRole(newPlayers, newTeamPlayers.length, newPlayerRole));
                        setNewPlayerInput('');
                      }
                    }}
                  >
                    Add
                  </button>
                </div>
                {newTeamPlayers.length > 0 && (
                  <ul className="players-chip-list">
                    {newTeamPlayers.map((p, i) => (
                      <li key={i} className={`player-chip ${p.active ? 'active' : ''}`}>
                        <select
                          value={p.active ? 'active' : 'inactive'}
                          onChange={(e) => setNewTeamPlayers(prev => prev.map((x, j) => j === i ? { ...x, active: e.target.value === 'active' } : x))}
                          className="chip-active-select"
                          title="Active = playing on match day"
                        >
                          <option value="active">Active</option>
                          <option value="inactive">Inactive</option>
                        </select>
                        <select
                          value={p.role || 'player'}
                          onChange={(e) => setNewTeamPlayers(setPlayerRole(newTeamPlayers, i, e.target.value))}
                          className="chip-role-select"
                          title="Captain / Vice Captain"
                        >
                          {PLAYER_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                        <span>{p.name}</span>
                        <span className="player-type-badge">{p.type || 'Batsman'}</span>
                        <button type="button" className="chip-remove" onClick={() => setNewTeamPlayers(prev => prev.filter((_, j) => j !== i))}>×</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button type="submit" className="btn btn-primary">Add Team</button>
            </form>
            {editingTeam && (
              <form onSubmit={handleUpdateTeam} className="team-form edit-team-form">
                <h4>Edit Team</h4>
                <input
                  type="text"
                  value={editingTeam.name}
                  onChange={(e) => setEditingTeam(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="Team name"
                  required
                />
                <input
                  type="text"
                  value={editingTeam.code}
                  onChange={(e) => setEditingTeam(prev => ({ ...prev, code: e.target.value }))}
                  placeholder="Code"
                  maxLength={10}
                />
                <div className="form-group-players">
                  <label>Players — Active/Inactive, Captain/Vice Captain (playing on match day)</label>
                  <div className="import-players-section">
                    <h5>Import from JSON</h5>
                    <p className="import-hint">Paste a JSON array. Format: <code>[{'{'} "name": "Player Name", "active": true, "role": "player", "type": "Batsman" {'}'}, ...]</code></p>
                    <textarea
                      value={importJsonText}
                      onChange={(e) => { setImportJsonText(e.target.value); setImportError(''); }}
                      placeholder={`[\n  { "name": "Shubman Gill", "active": true, "role": "captain", "type": "Batsman" },\n  ...\n]`}
                      className="import-json-textarea"
                      rows={4}
                    />
                    {importError && <p className="import-error">{importError}</p>}
                    <div className="import-actions">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => handleImportPlayersEdit(true)}>Replace & Import</button>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleImportPlayersEdit(false)}>Merge & Import</button>
                    </div>
                  </div>
                  <div className="player-add-row">
                    <input
                      type="text"
                      value={editPlayerInput}
                      onChange={(e) => setEditPlayerInput(e.target.value)}
                      placeholder="Add player"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addPlayerToEdit();
                        }
                      }}
                    />
                    <select
                      value={editPlayerType}
                      onChange={(e) => setEditPlayerType(e.target.value)}
                      className="player-type-select"
                    >
                      {PLAYER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <select
                      value={editPlayerActive ? 'active' : 'inactive'}
                      onChange={(e) => setEditPlayerActive(e.target.value === 'active')}
                      className="player-active-select"
                      title="Active = playing on match day"
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                    <select
                      value={editPlayerRole}
                      onChange={(e) => setEditPlayerRole(e.target.value)}
                      className="player-role-select"
                      title="Captain / Vice Captain"
                    >
                      {PLAYER_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={addPlayerToEdit}>Add</button>
                  </div>
                  {(editingTeam.players || []).length > 0 && (
                    <ul className="players-chip-list">
                      {(editingTeam.players || []).map((p, i) => (
                        <li key={i} className={`player-chip ${p.active ? 'active' : ''}`}>
                          <select
                            value={p.active ? 'active' : 'inactive'}
                            onChange={(e) => setEditingTeam(prev => ({
                              ...prev,
                              players: prev.players.map((x, j) => j === i ? { ...x, active: e.target.value === 'active' } : x),
                            }))}
                            className="chip-active-select"
                            title="Active = playing on match day"
                          >
                            <option value="active">Active</option>
                            <option value="inactive">Inactive</option>
                          </select>
                          <select
                            value={p.role || 'player'}
                            onChange={(e) => setEditingTeam(prev => ({
                              ...prev,
                              players: setPlayerRole(prev.players, i, e.target.value),
                            }))}
                            className="chip-role-select"
                            title="Captain / Vice Captain"
                          >
                            {PLAYER_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                          </select>
                          <span>{p.name}</span>
                          <select
                            value={p.type || 'Batsman'}
                            onChange={(e) => setEditingTeam(prev => ({
                              ...prev,
                              players: prev.players.map((x, j) => j === i ? { ...x, type: e.target.value } : x),
                            }))}
                            className="chip-type-select"
                          >
                            {PLAYER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                          <button type="button" className="chip-remove" onClick={() => setEditingTeam(prev => ({ ...prev, players: prev.players.filter((_, j) => j !== i) }))}>×</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="form-actions">
                  <button type="button" className="btn btn-cancel" onClick={() => setEditingTeam(null)}>Cancel</button>
                  <button type="submit" className="btn btn-primary">Save</button>
                </div>
              </form>
            )}
            <ul className="teams-list teams-list-admin">
              {teams.map(t => {
                const players = normalizePlayers(t.players || []);
                const activeCount = players.filter(p => p.active).length;
                return (
                  <li key={t.id} className="team-row-wrapper">
                    <div className="team-row">
                      <button
                        type="button"
                        className="team-name-btn"
                        onClick={() => setExpandedTeamId(expandedTeamId === t.id ? null : t.id)}
                      >
                        {t.name}{t.code ? ` (${t.code})` : ''}
                        <span className="team-count"> — {players.length} players, {activeCount} active</span>
                      </button>
                      <div className="team-row-actions">
                        <button type="button" className="btn btn-sm btn-icon-only" onClick={() => handleEditTeam(t)} title="Edit" aria-label="Edit">✏️</button>
                        <button type="button" className="btn btn-sm btn-danger btn-icon-only" onClick={() => handleDeleteTeam(t.id)} title="Remove" aria-label="Remove">🗑️</button>
                      </div>
                    </div>
                    {expandedTeamId === t.id && (
                      <div className="team-players-detail">
                        <strong>Total: {players.length} · Active (playing): {activeCount}</strong>
                        {players.length > 0 ? (
                          <ul className="team-players-list">
                            {players.map((p, i) => (
                              <li key={i} className={p.active ? 'player-active' : ''}>
                                {p.active && <span className="active-badge">✓</span>}
                                {p.name}
                                {p.role === 'captain' && <span className="role-badge role-captain">C</span>}
                                {p.role === 'viceCaptain' && <span className="role-badge role-vice-captain">VC</span>}
                                <span className="player-type-tag">{p.type || 'Batsman'}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="muted">No players added yet.</p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
          )}

          {activeSection === 'rules' && (
          <section id="section-rules" className="admin-section">
            <h2>Add Rule</h2>
            <p className="muted">Add key-value pairs. Position ID controls display order (lower = first). Key appears in bold for users.</p>
            <form onSubmit={handleAddRule} className="rule-form" onKeyDown={(e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); }}>
              <input
                type="number"
                min="0"
                value={newRulePosition}
                onChange={(e) => setNewRulePosition(e.target.value)}
                placeholder="Position (0=first)"
                className="rule-position-input"
                style={{ width: `${Math.max(6, String(newRulePosition ?? '').length + 2)}ch`, minWidth: '4rem', maxWidth: '6rem' }}
                title="Position: rules are shown to users ordered by this (ascending). Lower = earlier."
              />
              <input
                type="text"
                value={newRuleKey}
                onChange={(e) => setNewRuleKey(e.target.value)}
                placeholder="Key (e.g. Points, Deadline)"
                className="rule-input-auto"
                style={{ width: `${Math.max(12, (newRuleKey || '').length + 2)}ch`, minWidth: '12ch', maxWidth: '40ch' }}
              />
              <textarea
                value={newRuleValue}
                onChange={(e) => setNewRuleValue(e.target.value)}
                placeholder="Value / Description (Enter for new line, click Add Rule to save)"
                className="rule-textarea"
                rows={Math.max(2, (newRuleValue || '').split('\n').length)}
                style={{ minHeight: '2.5em' }}
              />
              <button type="submit" className="btn btn-primary">Add Rule</button>
            </form>
            {editingRule && (
              <form onSubmit={handleUpdateRule} className="rule-form edit-rule-form" onKeyDown={(e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); }}>
                <h4>Edit Rule</h4>
                <input
                  type="number"
                  min="0"
                  value={editingRule.position ?? 0}
                  onChange={(e) => setEditingRule(prev => ({ ...prev, position: e.target.value }))}
                  placeholder="Position"
                  className="rule-position-input"
                  style={{ width: `${Math.max(6, String(editingRule.position ?? '').length + 2)}ch`, minWidth: '4rem', maxWidth: '6rem' }}
                  title="Position: lower = shown earlier to users"
                />
                <input
                  type="text"
                  value={editingRule.key}
                  onChange={(e) => setEditingRule(prev => ({ ...prev, key: e.target.value }))}
                  placeholder="Key"
                  className="rule-input-auto"
                  style={{ width: `${Math.max(12, (editingRule.key || '').length + 2)}ch`, minWidth: '12ch', maxWidth: '40ch' }}
                />
                <textarea
                  value={editingRule.content}
                  onChange={(e) => setEditingRule(prev => ({ ...prev, content: e.target.value }))}
                  placeholder="Value / Description (Enter for new line, click Save to update)"
                  className="rule-textarea"
                  rows={Math.max(2, (editingRule.content || '').split('\n').length)}
                  style={{ minHeight: '2.5em' }}
                />
                <div className="form-actions">
                  <button type="submit" className="btn btn-primary">Save</button>
                  <button type="button" className="btn btn-cancel" onClick={() => setEditingRule(null)}>Cancel</button>
                </div>
              </form>
            )}
            <ul className="rules-list">
              {[...rules].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(r => (
                <li key={r.id} className="rule-list-item">
                  <span className="rule-position-badge" title="Position">{r.position ?? 0}</span>
                  <span>{r.key ? <><strong>{r.key}:</strong> {r.content}</> : r.content}</span>
                  <div className="rule-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm btn-icon-only"
                      onClick={() => handleEditRule(r)}
                      title="Edit"
                      aria-label="Edit"
                    >
                      ✏️
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm btn-icon-only"
                      onClick={() => handleRemoveRule(r)}
                      disabled={removingRuleId === r.id}
                      title={removingRuleId === r.id ? 'Removing...' : 'Remove'}
                      aria-label="Remove"
                    >
                      {removingRuleId === r.id ? '⋯' : '🗑️'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          )}

          {activeSection === 'passwordPolicy' && (
          <section id="section-program-config" className="admin-section">
            <h2>Program Config</h2>
            <form onSubmit={handleSaveProgramConfig} className="config-form">
              <div className="config-grid">
                <div className="config-card">
                  <h3>Program</h3>
                  <p className="muted">Match start date for late-registration approval. Users who register on or after this date need admin approval before they can predict matches.</p>
                  <div className="config-item">
                    <label>Match start date (YYYY-MM-DD):</label>
                    <input
                      type="date"
                      value={programConfig.matchStartDate || ''}
                      onChange={(e) => setProgramConfig(prev => ({ ...prev, matchStartDate: e.target.value }))}
                    />
                  </div>
                  <p className="muted config-note">Leave empty to allow all users to predict without approval.</p>
                  <div className="config-item">
                    <label>Push notification check interval (minutes):</label>
                    <input
                      type="number"
                      min="1"
                      max="60"
                      value={programConfig.scheduleIntervalMinutes ?? 10}
                      onChange={(e) => setProgramConfig(prev => ({ ...prev, scheduleIntervalMinutes: e.target.value }))}
                    />
                  </div>
                  <p className="muted config-note">How often the prediction reminder is checked (1–60 min). Function runs every 5 min; this controls how often reminders are actually sent.</p>
                  <div className="config-item config-item-checkbox">
                    <label className="config-checkbox-label">
                      <input
                        type="checkbox"
                        checked={programConfig.notifyOnPointsCalculated !== false}
                        onChange={(e) => setProgramConfig(prev => ({ ...prev, notifyOnPointsCalculated: e.target.checked }))}
                      />
                      <span>Notify users (push) when points are calculated or recalculated</span>
                    </label>
                  </div>
                  <p className="muted config-note">When off, Calculate Points / Recalculate still saves points but does not send &quot;Points calculated&quot; notifications.</p>
                  <div className="config-item">
                    <label>Loser % (bottom of leaderboard):</label>
                    <input
                      type="number"
                      min="0"
                      max="50"
                      value={programConfig.loserPercent ?? 25}
                      onChange={(e) => setProgramConfig(prev => ({ ...prev, loserPercent: e.target.value }))}
                    />
                  </div>
                  <p className="muted config-note">Bottom X% of leaderboard = loser 📉; top (100−X)% = winner 🏆. Default 25.</p>
                  <div className="config-item">
                    <label htmlFor="crowd-pred-visibility">Crowd prediction % (default):</label>
                    <select
                      id="crowd-pred-visibility"
                      value={programConfig.crowdPredictionVisibility === 'afterCutoff' ? 'afterCutoff' : 'always'}
                      onChange={(e) => setProgramConfig(prev => ({ ...prev, crowdPredictionVisibility: e.target.value }))}
                    >
                      <option value="always">Show before and after prediction cutoff</option>
                      <option value="afterCutoff">Show only after cutoff + delay (below)</option>
                    </select>
                  </div>
                  <div className="config-item">
                    <label htmlFor="crowd-pred-minutes-after">Minutes after prediction cutoff (crowd % delay):</label>
                    <input
                      id="crowd-pred-minutes-after"
                      type="number"
                      min="0"
                      max="1440"
                      value={programConfig.crowdPredictionMinutesAfterCutoff ?? 10}
                      onChange={(e) =>
                        setProgramConfig((prev) => ({ ...prev, crowdPredictionMinutesAfterCutoff: e.target.value }))
                      }
                    />
                  </div>
                  <p className="muted config-note">
                    When “after cutoff + delay” is selected (globally or per match), crowd percentages appear only after
                    the match’s prediction cutoff time plus this many minutes (default 10). Per-match overrides can still
                    choose always vs delayed visibility when adding or editing a match.
                  </p>
                </div>
                <div className="config-card">
                  <h3>Point Rules</h3>
                  <p className="muted">Set penalties (as positive numbers). Winners share the pool equally.</p>
                  <div className="config-item">
                    <label>Not participated (points deducted):</label>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={pointRules.notParticipatedPoints ?? 7}
                      onChange={(e) => setPointRules(prev => ({ ...prev, notParticipatedPoints: e.target.value }))}
                    />
                  </div>
                  <div className="config-item">
                    <label>Wrong prediction (points deducted):</label>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={pointRules.wrongPredictionPoints ?? 5}
                      onChange={(e) => setPointRules(prev => ({ ...prev, wrongPredictionPoints: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="config-card">
                  <h3>Password & Account</h3>
                  <p className="muted">Max forgot-password resets per user. Change password has no limit.</p>
                  <div className="config-item">
                    <label>Max forgot-password resets per user:</label>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={passwordPolicy.maxPasswordChanges ?? 2}
                      onChange={(e) => setPasswordPolicy(prev => ({ ...prev, maxPasswordChanges: e.target.value }))}
                    />
                  </div>
                  <div className="config-item">
                    <label>Account surrender deadline (YYYY-MM-DD):</label>
                    <input
                      type="date"
                      value={passwordPolicy.surrenderDeadline || ''}
                      onChange={(e) => setPasswordPolicy(prev => ({ ...prev, surrenderDeadline: e.target.value }))}
                      placeholder="Leave empty to disable"
                    />
                  </div>
                  <p className="muted config-note">Users can surrender only until this date. Leave empty to disable.</p>
                </div>

                <div className="config-card">
                  <h3>Cricket Insights</h3>
                  <p className="muted">Control visibility and question limits per match.</p>
                  <div className="config-item">
                    <label className="form-check">
                      <input
                        type="checkbox"
                        checked={cricketInsightsConfig.enabled}
                        onChange={(e) => setCricketInsightsConfig(prev => ({ ...prev, enabled: e.target.checked }))}
                      />
                      Cricket Insights button visible
                    </label>
                  </div>
                  <div className="config-item">
                    <label>Max questions per user per match:</label>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={cricketInsightsConfig.maxQuestionsPerUserPerMatch ?? 1}
                      onChange={(e) => setCricketInsightsConfig(prev => ({ ...prev, maxQuestionsPerUserPerMatch: e.target.value }))}
                    />
                  </div>
                  <div className="config-item">
                    <label>Max total questions per match:</label>
                    <input
                      type="number"
                      min="1"
                      max="20"
                      value={cricketInsightsConfig.maxQuestionsPerMatch ?? 5}
                      onChange={(e) => setCricketInsightsConfig(prev => ({ ...prev, maxQuestionsPerMatch: e.target.value }))}
                    />
                  </div>
                  <div className="config-item">
                    <label>Required approvals (when &gt;1, question needs ≥50% to appear):</label>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={cricketInsightsConfig.requiredApprovals ?? 1}
                      onChange={(e) => setCricketInsightsConfig(prev => ({ ...prev, requiredApprovals: e.target.value }))}
                      title="1 = single approver; 2+ = need at least 50% of this number of approvals"
                    />
                    <p className="muted config-note">e.g. 2 = need 1 approval, 4 = need 2 approvals</p>
                  </div>
                  <div className="config-item">
                    <label>Wrong insight answer penalty (points deducted per wrong answer when admin sets correct answer):</label>
                    <input
                      type="number"
                      min="0"
                      step="0.05"
                      value={cricketInsightsConfig.insightWrongAnswerPenalty ?? 0.25}
                      onChange={(e) =>
                        setCricketInsightsConfig((prev) => ({
                          ...prev,
                          insightWrongAnswerPenalty: e.target.value === '' ? '' : Number(e.target.value),
                        }))
                      }
                    />
                    <p className="muted config-note">
                      Default 0.25. If unset in older data, falls back to Point rules &quot;Wrong prediction&quot; value.
                    </p>
                  </div>
                  <div className="config-item">
                    <label className="form-check">
                      <input
                        type="checkbox"
                        checked={cricketInsightsConfig.allowInsightQuestionsAfterPredictionCutoff === true}
                        onChange={(e) =>
                          setCricketInsightsConfig((prev) => ({
                            ...prev,
                            allowInsightQuestionsAfterPredictionCutoff: e.target.checked,
                          }))
                        }
                      />
                      Allow new insight questions after match prediction cutoff
                    </label>
                  </div>
                  <div className="config-item">
                    <label className="form-check">
                      <input
                        type="checkbox"
                        checked={cricketInsightsConfig.allowInsightAnswersAfterPredictionCutoff === true}
                        onChange={(e) =>
                          setCricketInsightsConfig((prev) => ({
                            ...prev,
                            allowInsightAnswersAfterPredictionCutoff: e.target.checked,
                          }))
                        }
                      />
                      Allow insight answer submissions after match prediction cutoff
                    </label>
                  </div>
                  <div className="config-item">
                    <label>Insight Approvers:</label>
                    <div className="config-approvers">
                      <select
                        onChange={(e) => {
                          const uid = e.target.value;
                          if (uid && !(cricketInsightsConfig.insightApproverIds || []).includes(uid)) {
                            setCricketInsightsConfig(prev => ({
                              ...prev,
                              insightApproverIds: [...(prev.insightApproverIds || []), uid],
                            }));
                            e.target.value = '';
                          }
                        }}
                        defaultValue=""
                      >
                        <option value="">Select user to add...</option>
                        {usernameLookupList
                          .filter(u => !(cricketInsightsConfig.insightApproverIds || []).includes(u.userId))
                          .sort((a, b) => (a.username || '').localeCompare(b.username || ''))
                          .map(u => (
                            <option key={u.userId} value={u.userId}>
                              {toInitCap((u.username || '').replace(/_/g, ' '))}
                            </option>
                          ))}
                      </select>
                      {(cricketInsightsConfig.insightApproverIds || []).length > 0 && (
                        <ul className="config-approvers-list">
                          {(cricketInsightsConfig.insightApproverIds || []).map(uid => {
                            const u = usernameLookupList.find(x => x.userId === uid) || allUsers.find(x => x.id === uid);
                            const displayName = u?.username ? toInitCap(String(u.username).replace(/_/g, ' ')) : (u?.email || uid);
                            return (
                              <li key={uid} className="config-approver-item">
                                <span>{displayName}</span>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-danger"
                                  onClick={() => setCricketInsightsConfig(prev => ({
                                    ...prev,
                                    insightApproverIds: (prev.insightApproverIds || []).filter(id => id !== uid),
                                  }))}
                                >
                                  Remove
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  </div>
                  <p className="muted config-note">Admins can always approve. Add users here to grant approval access.</p>
                </div>
              </div>
              <button type="submit" className="btn btn-primary" style={{ marginTop: '1rem' }}>Save</button>
            </form>
          </section>
          )}

          {activeSection === 'users' && (
          <section id="section-users" className="admin-section">
            <h2>Users <span className="users-count-badge">({allUsers.length} total)</span></h2>
            <p className="muted">Remove users to revoke app access. Set password updates their Firebase login (tell them the new password securely). Users who registered on or after the match start date need approval before they can predict. You cannot change your own password here—use the dashboard account settings.</p>
            {usersFetchError ? (
              <p className="alert alert-error">{usersFetchError}</p>
            ) : allUsers.length === 0 ? (
              <p className="no-matches">No users found.</p>
            ) : (
              <ul className="rules-list">
                {allUsers
                  .filter(u => u.id !== user?.uid)
                  .sort((a, b) => (a.username || a.email || '').localeCompare(b.username || b.email || ''))
                  .map(u => {
                    const matchStartDate = (programConfig.matchStartDate || '').trim();
                    const createdAtDate = (u.createdAt || '').toString().split('T')[0];
                    const registeredAfterStart = matchStartDate && createdAtDate && createdAtDate >= matchStartDate;
                    const needsApproval = registeredAfterStart && u.predictionApproved !== true;
                    return (
                    <li key={u.id} className="user-list-item">
                      <span>{toInitCap(u.username || u.email || 'User')}</span>
                      <span className="muted"> ({u.email || u.id})</span>
                      {u.isAdmin && <span className="badge-admin">Admin</span>}
                      {needsApproval && <span className="badge badge-pending">Awaiting approval</span>}
                      {registeredAfterStart && u.predictionApproved && <span className="badge badge-approved">Approved</span>}
                      {needsApproval && (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => handleApproveUser(u)}
                          disabled={approvingUserId === u.id}
                        >
                          {approvingUserId === u.id ? 'Approving...' : 'Approve for predictions'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setSetPasswordUser(u);
                          setAdminSetPasswordNew('');
                          setAdminSetPasswordConfirm('');
                          setMessage('');
                        }}
                      >
                        Set password
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleRemoveUser(u)}
                        disabled={removingUserId === u.id}
                      >
                        {removingUserId === u.id ? 'Removing...' : 'Remove'}
                      </button>
                    </li>
                    );
                  })}
              </ul>
            )}
          </section>
          )}

          {activeSection === 'exportPoints' && (
          <section id="section-export-points" className="admin-section">
            <h2>Export points (Excel)</h2>
            <p className="muted">
              Sheet <strong>Points</strong>: one row per user per match (match date, username, teams, predicted winner, winner, points).
              Sheet <strong>Leaderboard</strong>: total points per user for the same range, ranked (ties share rank).
              Only matches with saved point results in the selected date range are included (non-admin users only).
            </p>
            <div className="config-grid" style={{ marginTop: '1rem', maxWidth: '520px' }}>
              <div className="config-card">
                <div className="config-item">
                  <label htmlFor="export-from">From date</label>
                  <input
                    id="export-from"
                    type="date"
                    value={pointsExportFrom}
                    onChange={(e) => setPointsExportFrom(e.target.value)}
                  />
                </div>
                <div className="config-item">
                  <label htmlFor="export-to">To date</label>
                  <input
                    id="export-to"
                    type="date"
                    value={pointsExportTo}
                    onChange={(e) => setPointsExportTo(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleExportPointsExcel}
                  disabled={pointsExportLoading}
                >
                  {pointsExportLoading ? 'Preparing…' : 'Download .xlsx'}
                </button>
              </div>
            </div>
          </section>
          )}

          {activeSection === 'predictionContexts' && (
            <PredictionContextsAdminPanel teams={teams} allUsers={allUsers} setMessage={setMessage} />
          )}

          {activeSection === 'matches' && (
          <section id="section-matches" className="admin-section">
            <h3>Import Matches (bulk)</h3>
            <div className="import-players-section">
              <h5>Paste JSON array</h5>
              <p className="import-hint">
                Paste a JSON <strong>array</strong> of matches (or <code>{'{'}"matches": [ ... ]{'}'}</code>). Each row needs <strong>team1</strong>, <strong>team2</strong>, <strong>date</strong> (YYYY-MM-DD). Optional: <strong>matchId</strong>/<strong>matchNumber</strong>, <strong>time</strong>, <strong>thresholdTime</strong>, <strong>status</strong>, <strong>stadium</strong>, <strong>city</strong>, <strong>crowdPredictionVisibility</strong> (<code>always</code> or <code>afterCutoff</code>).
                Bulk import uses batched writes (up to 450 per batch).
              </p>
              <textarea
                value={importMatchJsonText}
                onChange={(e) => { setImportMatchJsonText(e.target.value); setImportMatchError(''); }}
                placeholder={`[\n  { "matchId": "1", "team1": "PUNJAB KINGS", "team2": "GUJARAT TITANS", "date": "2026-03-31", "time": "19:30", "thresholdTime": "19:00", "stadium": "Narendra Modi Stadium", "city": "Ahmedabad", "status": "open" },\n  ...\n]`}
                className="import-json-textarea"
                rows={10}
              />
              {importMatchError && <p className="import-error">{importMatchError}</p>}
              <button type="button" className="btn btn-primary btn-sm" onClick={handleImportMatches} disabled={importMatchLoading || teams.length === 0}>
                {importMatchLoading ? 'Importing...' : 'Import Matches'}
              </button>
              {teams.length === 0 && <p className="muted" style={{ marginTop: '0.5rem' }}>Add teams first in the Teams section.</p>}
            </div>

            <h2>Add Match</h2>
            {teams.length === 0 ? (
              <p className="muted">Add teams first in the Teams section.</p>
            ) : (
            <form onSubmit={handleAddMatch} className="match-form">
              <div className="form-row">
                <div className="form-group-inline" style={{ flex: 1, minWidth: '200px' }}>
                  <label htmlFor="match-display-name">Match name (optional)</label>
                  <input
                    id="match-display-name"
                    type="text"
                    value={matchForm.matchName || ''}
                    onChange={(e) => setMatchForm(prev => ({ ...prev, matchName: e.target.value }))}
                    placeholder="e.g. Qualifier 1, Rivalry week"
                    autoComplete="off"
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group-inline">
                  <label htmlFor="match-number">Match ID:</label>
                  <input
                    id="match-number"
                    type="text"
                    value={matchForm.matchNumber}
                    onChange={(e) => setMatchForm(prev => ({ ...prev, matchNumber: e.target.value }))}
                    placeholder="e.g. 1, 2, M1"
                    required
                    style={{ width: '80px' }}
                  />
                </div>
              </div>
              <div className="form-row">
                <select
                  value={matchForm.team1}
                  onChange={(e) => setMatchForm(prev => ({ ...prev, team1: e.target.value }))}
                  required
                >
                  <option value="">Select Team 1</option>
                  {teams.map(t => (
                    <option key={t.id} value={t.name}>{t.name}{t.code ? ` (${t.code})` : ''}</option>
                  ))}
                </select>
                <span>vs</span>
                <select
                  value={matchForm.team2}
                  onChange={(e) => setMatchForm(prev => ({ ...prev, team2: e.target.value }))}
                  required
                >
                  <option value="">Select Team 2</option>
                  {teams.map(t => (
                    <option key={t.id} value={t.name}>{t.name}{t.code ? ` (${t.code})` : ''}</option>
                  ))}
                </select>
              </div>
              {matchForm.team1 && matchForm.team2 && matchForm.team1 === matchForm.team2 && (
                <p className="alert alert-error">Team 1 and Team 2 must be different.</p>
              )}
              <div className="form-row">
                <input
                  type="date"
                  value={matchForm.date}
                  onChange={(e) => setMatchForm(prev => ({ ...prev, date: e.target.value }))}
                />
                <input
                  type="time"
                  value={matchForm.time}
                  onChange={(e) => setMatchForm(prev => ({ ...prev, time: e.target.value }))}
                  title="Match time"
                />
                <div className="form-group-inline">
                  <label htmlFor="threshold">Predict before:</label>
                  <input
                    id="threshold"
                    type="time"
                    value={matchForm.thresholdTime}
                    onChange={(e) => setMatchForm(prev => ({ ...prev, thresholdTime: e.target.value }))}
                    title="Users must predict before this time"
                  />
                </div>
              </div>
              <div className="form-row match-venue-row">
                <div className="form-group-inline" style={{ flex: 1, minWidth: '140px' }}>
                  <label htmlFor="match-stadium">Stadium (optional)</label>
                  <input
                    id="match-stadium"
                    type="text"
                    value={matchForm.stadium}
                    onChange={(e) => setMatchForm(prev => ({ ...prev, stadium: e.target.value }))}
                    placeholder="e.g. Wankhede Stadium"
                    autoComplete="off"
                  />
                </div>
                <div className="form-group-inline" style={{ flex: 1, minWidth: '120px' }}>
                  <label htmlFor="match-city">City (optional)</label>
                  <input
                    id="match-city"
                    type="text"
                    value={matchForm.city}
                    onChange={(e) => setMatchForm(prev => ({ ...prev, city: e.target.value }))}
                    placeholder="e.g. Mumbai"
                    autoComplete="off"
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group-inline" style={{ flex: 1, minWidth: '220px' }}>
                  <label htmlFor="match-crowd-visibility">Crowd % visibility</label>
                  <select
                    id="match-crowd-visibility"
                    value={matchForm.crowdPredictionVisibility || 'inherit'}
                    onChange={(e) => setMatchForm(prev => ({ ...prev, crowdPredictionVisibility: e.target.value }))}
                  >
                    <option value="inherit">Use program default</option>
                    <option value="always">Before &amp; after cutoff</option>
                    <option value="afterCutoff">After cutoff only</option>
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group-inline" style={{ flex: 1, minWidth: '160px' }}>
                  <label htmlFor="match-points-multiplier">Winner points multiplier (optional)</label>
                  <input
                    id="match-points-multiplier"
                    type="text"
                    inputMode="decimal"
                    value={matchForm.pointsMultiplier || ''}
                    onChange={(e) => setMatchForm(prev => ({ ...prev, pointsMultiplier: e.target.value }))}
                    placeholder="e.g. 2"
                    title="Applies only to pool share for correct predictions. Wrong and no-prediction penalties are not multiplied."
                    autoComplete="off"
                  />
                </div>
                <p className="muted form-hint-inline" style={{ flex: 1, minWidth: '200px', margin: 0, alignSelf: 'flex-end' }}>
                  e.g. 2 → correct pick gets (pool share × 2). Leave blank or 1 for normal scoring.
                </p>
              </div>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={matchForm.team1 && matchForm.team2 && matchForm.team1 === matchForm.team2}
              >
                Add Match
              </button>
            </form>
            )}

            <div className="matches-list">
              <h3>All Matches</h3>
              {matches.length === 0 ? (
                <p className="muted">No matches yet. Add one above.</p>
              ) : (
                <>
                <div className="bulk-actions-row">
                  <button type="button" className="btn btn-sm" onClick={selectAllMatches}>Select All</button>
                  <button type="button" className="btn btn-sm" onClick={deselectAllMatches}>Deselect All</button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={handleBulkDeleteMatches}
                    disabled={selectedMatchIds.length === 0 || bulkDeleteLoading}
                    title={selectedMatchIds.length === 0 ? 'Select matches to delete' : `Delete ${selectedMatchIds.length} selected`}
                  >
                    {bulkDeleteLoading ? 'Deleting...' : `Delete Selected (${selectedMatchIds.length})`}
                  </button>
                </div>
                <div className="matches-table">
                  <div className="match-row match-row-header">
                    <span className="match-col-check" aria-hidden="true" />
                    <span className="match-col-info">Match</span>
                    <span className="match-col-actions">Actions</span>
                  </div>
                  {editingMatch && (
                    <form onSubmit={handleUpdateMatch} className="match-form edit-form">
                      <h4>Edit Match</h4>
                      <div className="form-row">
                        <div className="form-group-inline" style={{ flex: 1, minWidth: '200px' }}>
                          <label htmlFor="edit-match-display-name">Match name (optional)</label>
                          <input
                            id="edit-match-display-name"
                            type="text"
                            value={editingMatch.matchName || ''}
                            onChange={(e) => setEditingMatch(prev => ({ ...prev, matchName: e.target.value }))}
                            placeholder="e.g. Qualifier 1, Rivalry week"
                            autoComplete="off"
                          />
                        </div>
                      </div>
                      <div className="form-row">
                        <div className="form-group-inline">
                          <label htmlFor="edit-match-number">Match ID:</label>
                          <input
                            id="edit-match-number"
                            type="text"
                            value={editingMatch.matchNumber || ''}
                            onChange={(e) => setEditingMatch(prev => ({ ...prev, matchNumber: e.target.value }))}
                            placeholder="e.g. 1, 2"
                            style={{ width: '80px' }}
                          />
                        </div>
                      </div>
                      <div className="form-row">
                        <select
                          value={editingMatch.team1}
                          onChange={(e) => setEditingMatch(prev => ({ ...prev, team1: e.target.value }))}
                          required
                        >
                          <option value="">Select Team 1</option>
                          {teams.map(t => (
                            <option key={t.id} value={t.name}>{t.name}{t.code ? ` (${t.code})` : ''}</option>
                          ))}
                        </select>
                        <span>vs</span>
                        <select
                          value={editingMatch.team2}
                          onChange={(e) => setEditingMatch(prev => ({ ...prev, team2: e.target.value }))}
                          required
                        >
                          <option value="">Select Team 2</option>
                          {teams.map(t => (
                            <option key={t.id} value={t.name}>{t.name}{t.code ? ` (${t.code})` : ''}</option>
                          ))}
                        </select>
                      </div>
                      {editingMatch.team1 && editingMatch.team2 && editingMatch.team1 === editingMatch.team2 && (
                        <p className="alert alert-error">Team 1 and Team 2 must be different.</p>
                      )}
                      <div className="form-row match-venue-row">
                        <div className="form-group-inline" style={{ flex: 1, minWidth: '140px' }}>
                          <label htmlFor="edit-match-stadium">Stadium (optional)</label>
                          <input
                            id="edit-match-stadium"
                            type="text"
                            value={editingMatch.stadium || ''}
                            onChange={(e) => setEditingMatch(prev => ({ ...prev, stadium: e.target.value }))}
                            placeholder="e.g. Wankhede Stadium"
                            autoComplete="off"
                          />
                        </div>
                        <div className="form-group-inline" style={{ flex: 1, minWidth: '120px' }}>
                          <label htmlFor="edit-match-city">City (optional)</label>
                          <input
                            id="edit-match-city"
                            type="text"
                            value={editingMatch.city || ''}
                            onChange={(e) => setEditingMatch(prev => ({ ...prev, city: e.target.value }))}
                            placeholder="e.g. Mumbai"
                            autoComplete="off"
                          />
                        </div>
                      </div>
                      <div className="form-row">
                        <div className="form-group-inline" style={{ flex: 1, minWidth: '220px' }}>
                          <label htmlFor="edit-match-crowd-visibility">Crowd % visibility</label>
                          <select
                            id="edit-match-crowd-visibility"
                            value={editingMatch.crowdPredictionVisibility || 'inherit'}
                            onChange={(e) => setEditingMatch(prev => ({ ...prev, crowdPredictionVisibility: e.target.value }))}
                          >
                            <option value="inherit">Use program default</option>
                            <option value="always">Before &amp; after cutoff</option>
                            <option value="afterCutoff">After cutoff only</option>
                          </select>
                        </div>
                      </div>
                      <div className="form-row">
                        <div className="form-group-inline" style={{ flex: 1, minWidth: '160px' }}>
                          <label htmlFor="edit-match-points-multiplier">Winner points multiplier (optional)</label>
                          <input
                            id="edit-match-points-multiplier"
                            type="text"
                            inputMode="decimal"
                            value={editingMatch.pointsMultiplier || ''}
                            onChange={(e) => setEditingMatch(prev => ({ ...prev, pointsMultiplier: e.target.value }))}
                            placeholder="1"
                            title="Pool share for correct predictions only; penalties unchanged"
                            autoComplete="off"
                          />
                        </div>
                        <p className="muted form-hint-inline" style={{ flex: 1, minWidth: '200px', margin: 0, alignSelf: 'flex-end' }}>
                          Blank = 1×. Recalculate points after changing.
                        </p>
                      </div>
                      <div className="form-row">
                        <input
                          type="date"
                          value={editingMatch.date}
                          onChange={(e) => setEditingMatch(prev => ({ ...prev, date: e.target.value }))}
                        />
                        <input
                          type="time"
                          value={editingMatch.time}
                          onChange={(e) => setEditingMatch(prev => ({ ...prev, time: e.target.value }))}
                          title="Match time"
                        />
                        <div className="form-group-inline">
                          <label>Predict before:</label>
                          <input
                            type="time"
                            value={editingMatch.thresholdTime}
                            onChange={(e) => setEditingMatch(prev => ({ ...prev, thresholdTime: e.target.value }))}
                          />
                        </div>
                        <div className="form-group-inline">
                          <label>Status:</label>
                          <select
                            value={editingMatch.status || 'open'}
                            onChange={(e) => setEditingMatch(prev => ({ ...prev, status: e.target.value }))}
                          >
                            <option value="open">Upcoming</option>
                            <option value="completed">Completed</option>
                          </select>
                        </div>
                        {editingMatch.team1 && editingMatch.team2 && (
                          <div className="form-group-inline">
                            <label>Winner:</label>
                            <select
                              value={editingMatch.winner || ''}
                              onChange={(e) => setEditingMatch(prev => ({ ...prev, winner: e.target.value }))}
                            >
                              <option value="">— Not decided —</option>
                              <option value={editingMatch.team1}>{editingMatch.team1}</option>
                              <option value={editingMatch.team2}>{editingMatch.team2}</option>
                              <option value={MATCH_WINNER_DRAW}>Draw</option>
                              <option value={MATCH_WINNER_CANCELLED}>Cancelled</option>
                            </select>
                          </div>
                        )}
                        <button
                          type="submit"
                          className="btn btn-primary"
                          disabled={editingMatch.team1 && editingMatch.team2 && editingMatch.team1 === editingMatch.team2}
                        >
                          Save
                        </button>
                        <button type="button" className="btn btn-cancel" onClick={() => setEditingMatch(null)}>Cancel</button>
                      </div>
                    </form>
                  )}
                  {matches.map((m) => {
                    const matchPending = pendingQuestions.filter(q => q.matchId === m.id);
                    const matchAwaiting = questionsAwaitingAnswer.filter(q => q.matchId === m.id);
                    const matchAnswered = answeredInsightQuestions.filter(q => q.matchId === m.id);
                    const hasInsights =
                      matchPending.length > 0 || matchAwaiting.length > 0 || matchAnswered.length > 0;
                    const isInsightExpanded = expandedInsightMatchId === m.id;
                    return (
                    <div key={m.id} className="match-row">
                      <label className="match-select-checkbox">
                        <input
                          type="checkbox"
                          checked={selectedMatchIds.includes(m.id)}
                          onChange={() => toggleMatchSelection(m.id)}
                          title="Select for bulk delete"
                        />
                      </label>
                      <div className="match-info">
                        {(m.matchName?.trim() || getMatchPointsMultiplier(m) !== 1) && (
                          <div className="admin-match-title-row">
                            {m.matchName?.trim() && (
                              <span className="admin-match-display-name" title={m.matchName.trim()}>
                                {m.matchName.trim()}
                              </span>
                            )}
                            {getMatchPointsMultiplier(m) !== 1 && (
                              <span className="admin-match-mult-badge" title="Winner pool share is multiplied for this match">
                                ×{getMatchPointsMultiplier(m)}
                              </span>
                            )}
                          </div>
                        )}
                        {m.matchNumber && <span className="match-id-badge">#{m.matchNumber}</span>}
                        <span className="match-teams">{getTeamCode(m.team1, teams)} vs {getTeamCode(m.team2, teams)}</span>
                        <span className="match-meta">{m.date} · {formatMatchTime(m.time || m.slot)}</span>
                        {(m.stadium || m.city) && (
                          <span className="match-venue-inline">🏟 {[m.stadium, m.city].filter(Boolean).join(' · ')}</span>
                        )}
                        {m.winner && (
                          <span className="match-winner">
                            {isDrawOrCancelledWinner(m.winner)
                              ? `Result: ${getMatchResultLabel(m, getTeamCode, teams)}`
                              : `Winner: ${getTeamCode(m.winner, teams)}`}
                          </span>
                        )}
                        <span className={`match-status ${(m.status || 'open').toLowerCase() === 'completed' ? 'completed' : m.date === todayCal ? 'today' : 'open'}`}>
                        {(m.status || 'open').toLowerCase() === 'completed'
                          ? 'completed'
                          : m.date === todayCal
                            ? 'today'
                            : 'upcoming'}
                      </span>
                      </div>
                      <div className="match-actions">
                        {(m.status || '').toLowerCase() === 'completed' &&
                          m.winner &&
                          !isDrawOrCancelledWinner(m.winner) && (
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => handleCalculatePoints(m)}
                            disabled={calculatingMatchId === m.id}
                            title="Calculate and save points for this match"
                          >
                            {calculatingMatchId === m.id ? 'Calculating...' : m.pointResults ? 'Recalculate' : 'Calculate Points'}
                          </button>
                        )}
                        {(m.status || '').toLowerCase() === 'completed' && isDrawOrCancelledWinner(m.winner) && (
                          <span className="muted" style={{ fontSize: '0.85rem', alignSelf: 'center' }} title="No pool points; zeros saved for all users">
                            No score points
                          </span>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm btn-outline btn-icon-only"
                          onClick={() => openParticipantsModal(m)}
                          title="Participants: names only before prediction cutoff; team, times, history after cutoff; points when scored"
                          aria-label="View participants"
                        >
                          👥
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-outline btn-icon-only"
                          onClick={() => openMatchNotifyModal(m)}
                          title="Send push notification for this match"
                          aria-label="Send match notification"
                        >
                          🔔
                        </button>
                        {(m.date || '') <= todayCal && (
                          <button
                            type="button"
                            className={`btn btn-sm btn-insight btn-icon-only ${isInsightExpanded ? 'active' : ''}`}
                            onClick={() => setExpandedInsightMatchId(isInsightExpanded ? null : m.id)}
                            title="Insight approval (visible to admin only)"
                            aria-label="Insight approval"
                          >
                            <span className="btn-insight-count">
                              {matchPending.length + matchAwaiting.length + matchAnswered.length}
                            </span>
                            💡
                          </button>
                        )}
                        <button type="button" className="btn btn-sm btn-icon-only" onClick={() => handleEditMatch(m)} title="Edit" aria-label="Edit">✏️</button>
                        <button type="button" className="btn btn-sm btn-danger btn-icon-only" onClick={() => handleDeleteMatch(m.id)} title="Remove" aria-label="Remove">🗑️</button>
                      </div>
                      {isInsightExpanded && (
                        <div className="match-insight-approval">
                          <p className="muted">Approve questions or set correct answer after match completes.</p>
                          {insightApprovalLoading ? (
                            <p>Loading...</p>
                          ) : (
                            <>
                              {matchPending.length > 0 && (
                                <div className="insight-subsection">
                                  <h4>Pending approval</h4>
                                  <ul className="rules-list">
                                    {matchPending.map(q => {
                                      const qApprovedBy = Array.isArray(q.approvedBy) ? q.approvedBy : [];
                                      const minReq = getMinApprovalsToShow(cricketInsightsConfig.requiredApprovals ?? 1);
                                      const alreadyApproved = qApprovedBy.includes(user.uid);
                                      return (
                                      <li key={q.id} className="insight-pending-item">
                                        <div className="insight-pending-content">
                                          <strong>{q.question}</strong>
                                          <span className="muted"> · {q.type === 'yesno' ? 'Yes/No' : q.type === 'multiple' ? 'Multiple Choice' : 'Text'}</span>
                                          {(cricketInsightsConfig.requiredApprovals ?? 1) > 1 && (
                                            <span className="muted" style={{ marginLeft: '0.25rem' }}>
                                              ({qApprovedBy.length}/{minReq} approvals)
                                            </span>
                                          )}
                                          {(q.options || []).length > 0 && (
                                            <p className="muted" style={{ margin: '0.25rem 0 0 0' }}>Options: {q.options.join(', ')}</p>
                                          )}
                                          <p className="muted" style={{ margin: '0.35rem 0 0 0', fontSize: '0.9em' }}>
                                            Raised by: <strong>{formatInsightUserLabel(allUsers, q.createdBy)}</strong>
                                            {qApprovedBy.length > 0 && (
                                              <> · Approved by: {qApprovedBy.map((uid) => formatInsightUserLabel(allUsers, uid)).join(', ')}</>
                                            )}
                                          </p>
                                        </div>
                                        <div className="insight-pending-actions">
                                          <button type="button" className="btn btn-sm btn-primary btn-icon-only" onClick={() => handleApproveQuestion(q)} disabled={approvingQid === q.id || alreadyApproved} title={alreadyApproved ? 'You already approved' : approvingQid === q.id ? 'Approving...' : 'Approve'} aria-label="Approve">
                                            {approvingQid === q.id ? '⋯' : '✓'}
                                          </button>
                                          <button type="button" className="btn btn-sm btn-danger btn-icon-only" onClick={() => handleRejectQuestion(q)} disabled={rejectingQid === q.id} title={rejectingQid === q.id ? 'Rejecting...' : 'Reject'} aria-label="Reject">
                                            {rejectingQid === q.id ? '⋯' : '✕'}
                                          </button>
                                          <button type="button" className="btn btn-sm btn-icon-only" onClick={() => handleRemoveQuestion(q)} disabled={removingQid === q.id} title={removingQid === q.id ? 'Removing...' : 'Permanently delete question'} aria-label="Remove">
                                            {removingQid === q.id ? '⋯' : '🗑️'}
                                          </button>
                                        </div>
                                      </li>
                                    );
                                    })}
                                  </ul>
                                </div>
                              )}
                              {matchAnswered.length > 0 && (
                                <div className="insight-subsection">
                                  <h4>Correct answer set (change if needed)</h4>
                                  <p className="muted" style={{ marginBottom: '0.5rem', fontSize: '0.9rem' }}>
                                    Changing the official answer updates stored insight points on the match (+1 / −1 per affected player).
                                  </p>
                                  <ul className="rules-list">
                                    {matchAnswered.map((q) => {
                                      const ab = Array.isArray(q.approvedBy) ? q.approvedBy : [];
                                      const ca = String(q.correctAnswer ?? '').trim();
                                      return (
                                        <li key={q.id} className="insight-pending-item">
                                          <div className="insight-pending-content">
                                            <strong>{q.question}</strong>
                                            <span className="muted"> · {q.type === 'yesno' ? 'Yes/No' : q.type === 'multiple' ? 'Multiple Choice' : 'Text'}</span>
                                            <p className="muted" style={{ margin: '0.35rem 0 0 0' }}>
                                              Current answer: <strong>{ca || '—'}</strong>
                                            </p>
                                            {(q.options || []).length > 0 && (
                                              <p className="muted" style={{ margin: '0.25rem 0 0 0', fontSize: '0.9em' }}>
                                                Options: {q.options.join(', ')}
                                              </p>
                                            )}
                                            <p className="muted" style={{ margin: '0.35rem 0 0 0', fontSize: '0.9em' }}>
                                              Raised by: <strong>{formatInsightUserLabel(allUsers, q.createdBy)}</strong>
                                              {ab.length > 0 && (
                                                <> · Approved by: {ab.map((uid) => formatInsightUserLabel(allUsers, uid)).join(', ')}</>
                                              )}
                                            </p>
                                          </div>
                                          <div className="insight-pending-actions">
                                            <button
                                              type="button"
                                              className="btn btn-sm btn-secondary"
                                              onClick={() => openChangeAnswerModal(q)}
                                              disabled={submittingAnswer}
                                              title="Change the official correct answer"
                                            >
                                              Change answer
                                            </button>
                                            <button
                                              type="button"
                                              className="btn btn-sm btn-icon-only"
                                              onClick={() => handleRemoveQuestion(q)}
                                              disabled={removingQid === q.id}
                                              title={removingQid === q.id ? 'Removing...' : 'Permanently delete question'}
                                              aria-label="Remove"
                                            >
                                              {removingQid === q.id ? '⋯' : '🗑️'}
                                            </button>
                                          </div>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              )}
                              {matchAwaiting.length > 0 && (
                                <div className="insight-subsection">
                                  <h4>Set correct answer (after match completes)</h4>
                                  {(m.status || '').toLowerCase() !== 'completed' && (
                                    <p className="muted" style={{ marginBottom: '0.5rem' }}>Mark the match as completed first, then you can submit the correct answer.</p>
                                  )}
                                  <ul className="rules-list">
                                    {matchAwaiting.map(q => {
                                      const ab = Array.isArray(q.approvedBy) ? q.approvedBy : [];
                                      return (
                                      <li key={q.id} className="insight-pending-item">
                                        <div className="insight-pending-content">
                                          <strong>{q.question}</strong>
                                          <span className="muted"> · {q.type === 'yesno' ? 'Yes/No' : q.type === 'multiple' ? 'Multiple Choice' : 'Text'}</span>
                                          {(q.options || []).length > 0 && (
                                            <p className="muted" style={{ margin: '0.25rem 0 0 0' }}>Options: {q.options.join(', ')}</p>
                                          )}
                                          <p className="muted" style={{ margin: '0.35rem 0 0 0', fontSize: '0.9em' }}>
                                            Raised by: <strong>{formatInsightUserLabel(allUsers, q.createdBy)}</strong>
                                            {ab.length > 0 && (
                                              <> · Approved by: {ab.map((uid) => formatInsightUserLabel(allUsers, uid)).join(', ')}</>
                                            )}
                                          </p>
                                          {q.answersDisabled === true && (
                                            <p className="muted" style={{ margin: '0.2rem 0 0 0' }}>User answers are disabled for this question.</p>
                                          )}
                                        </div>
                                        <div className="insight-pending-actions">
                                          {(userProfile?.isAdmin === true || userProfile?.isAdmin === 'true') && (
                                            <button
                                              type="button"
                                              className="btn btn-sm btn-secondary"
                                              onClick={() => handleToggleAnswersDisabled(q, !q.answersDisabled)}
                                              disabled={togglingAnswersQid === q.id}
                                              title={q.answersDisabled ? 'Allow users to answer' : 'Stop users from answering'}
                                            >
                                              {togglingAnswersQid === q.id ? '…' : q.answersDisabled ? 'Enable answers' : 'Disable answers'}
                                            </button>
                                          )}
                                          <button
                                            type="button"
                                            className="btn btn-sm btn-primary btn-icon-only"
                                            onClick={() => openAnswerModal(q)}
                                            disabled={submittingAnswer || (m.status || '').toLowerCase() !== 'completed'}
                                            title={(m.status || '').toLowerCase() !== 'completed' ? 'Mark match as completed first' : 'Set correct answer'}
                                            aria-label="Set correct answer"
                                          >
                                            ✓
                                          </button>
                                          <button type="button" className="btn btn-sm btn-icon-only" onClick={() => handleRemoveQuestion(q)} disabled={removingQid === q.id} title={removingQid === q.id ? 'Removing...' : 'Permanently delete question'} aria-label="Remove">
                                            {removingQid === q.id ? '⋯' : '🗑️'}
                                          </button>
                                        </div>
                                      </li>
                                    );
                                    })}
                                  </ul>
                                </div>
                              )}
                              {matchPending.length === 0 &&
                                matchAwaiting.length === 0 &&
                                matchAnswered.length === 0 && (
                                <p className="no-matches">No insight questions for this match.</p>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
                </>
              )}
            </div>
            {participantsModal && (
              <div className="modal-overlay" onClick={() => !participantsLoading && setParticipantsModal(null)}>
                <div className="modal-content participants-modal" onClick={e => e.stopPropagation()}>
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
                        const beforeCutoff = isPredictionEligible(m);
                        const showPickAndHistory = !beforeCutoff;
                        const isCompleted = (m?.status || '').toLowerCase() === 'completed' && (m?.winner || '').trim();
                        const pointResults = m?.pointResults && typeof m.pointResults === 'object' ? m.pointResults : null;
                        const showPoints = isCompleted && pointResults;
                        const showPredictedAt = showPickAndHistory;
                        const colClass = !showPickAndHistory
                          ? showPoints
                            ? 'participant-grid--admin-cutoff-user-points'
                            : 'participant-grid--admin-cutoff-user-only'
                          : showPoints
                            ? 'participant-grid--admin-5'
                            : 'participant-grid--admin-4';
                        return (
                          <>
                            {beforeCutoff ? (
                              <p className="muted participants-points-note">
                                Before the prediction cutoff ({formatMatchTime(m?.thresholdTime || m?.time)} on {m?.date}), only each
                                participant&apos;s name is shown. Predicted team, save times, history count, and full history are visible
                                after cutoff. Points still appear here when the match is completed and scored.
                              </p>
                            ) : (
                              <p className="muted participants-points-note">
                                <strong>History</strong> is the number of saved prediction versions for this match (first pick plus each
                                time they switched teams). Click the number to see every version with time and team, oldest first. Points
                                appear after the match is completed and you have saved scores.
                              </p>
                            )}
                            <ul className="participants-list">
                              <li className={`participants-list-header ${colClass}`}>
                                <span>User</span>
                                {showPickAndHistory && <span>Prediction</span>}
                                {showPredictedAt && <span className="col-predicted-at">Predicted at</span>}
                                {showPickAndHistory && <span className="col-history">History</span>}
                                {showPoints && <span className="col-points">Points</span>}
                              </li>
                              {participantsModal.participants.map((p, i) => {
                                const pts = showPoints && p.userId ? pointResults[p.userId] : undefined;
                                const ptsNum = pts != null && !Number.isNaN(Number(pts)) ? Number(pts) : null;
                                const timeStr = formatTimeHH24(p.predictedAtIso);
                                const log = p.changeLogSorted || [];
                                const historyCount = log.length;
                                const updateCount = Math.max(0, historyCount - 1);
                                return (
                                  <li key={p.userId || i} className={`participant-item ${colClass}`}>
                                    <span className="participant-name">{p.displayName}</span>
                                    {showPickAndHistory && (
                                      <span className="participant-prediction">
                                        {p.predictedWinner ? (getTeamCode(p.predictedWinner, teams) || p.predictedWinner) : '—'}
                                      </span>
                                    )}
                                    {showPredictedAt && (
                                      <span className="participant-predicted-at" title={p.predictedAtIso || undefined}>
                                        {timeStr}
                                      </span>
                                    )}
                                    {showPickAndHistory && (
                                      <span className="participant-change-count-cell">
                                        {log.length > 0 ? (
                                          <button
                                            type="button"
                                            className="btn btn-link participant-pred-changes-btn"
                                            onClick={() =>
                                              setPredictionHistoryModal({
                                                match: m,
                                                displayName: p.displayName,
                                                entries: log.map((e) => ({ ...e })),
                                              })
                                            }
                                            title={`${historyCount} saved version(s) for this match (${updateCount} update(s) after the first). Click for full timeline.`}
                                            aria-label={`Prediction history for ${p.displayName}: ${historyCount} saved version(s), ${updateCount} update(s) after first pick`}
                                          >
                                            {historyCount}
                                          </button>
                                        ) : (
                                          <span className="muted">—</span>
                                        )}
                                      </span>
                                    )}
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
            {predictionHistoryModal && (
              <div
                className="modal-overlay"
                role="dialog"
                aria-modal="true"
                aria-labelledby="prediction-history-title"
                onClick={() => setPredictionHistoryModal(null)}
              >
                <div className="modal-content participants-modal prediction-history-modal" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-header">
                    <h3 id="prediction-history-title">Prediction history — {predictionHistoryModal.displayName}</h3>
                    <button type="button" className="modal-close" onClick={() => setPredictionHistoryModal(null)} aria-label="Close">
                      &times;
                    </button>
                  </div>
                  <p className="muted" style={{ marginTop: 0 }}>
                    {getTeamCode(predictionHistoryModal.match?.team1, teams)} vs{' '}
                    {getTeamCode(predictionHistoryModal.match?.team2, teams)}
                    {predictionHistoryModal.match?.date ? ` · ${predictionHistoryModal.match.date}` : ''}
                  </p>
                  {(() => {
                    const n = predictionHistoryModal.entries.length;
                    const updatesAfterFirst = Math.max(0, n - 1);
                    return (
                      <p className="muted prediction-history-summary">
                        <strong>{n}</strong> saved version{n === 1 ? '' : 's'} in the log below (oldest → newest). Pick was updated{' '}
                        <strong>{updatesAfterFirst}</strong> time{updatesAfterFirst === 1 ? '' : 's'} after the first save.
                      </p>
                    );
                  })()}
                  {predictionHistoryModal.entries.length === 0 ? (
                    <p className="muted">No saved history for this match.</p>
                  ) : (
                    <table className="prediction-history-table">
                      <thead>
                        <tr>
                          <th scope="col" className="prediction-history-col-idx">
                            #
                          </th>
                          <th scope="col">Time</th>
                          <th scope="col" className="prediction-history-col-from">
                            From (previous)
                          </th>
                          <th scope="col" className="prediction-history-col-team">
                            To (saved)
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {predictionHistoryModal.entries.map((e, idx) => {
                          const fromWinner = idx > 0 ? predictionHistoryModal.entries[idx - 1].predictedWinner : '';
                          const fromLabel =
                            idx === 0 ? '—' : getTeamCode(fromWinner, teams) || fromWinner;
                          const toLabel = getTeamCode(e.predictedWinner, teams) || e.predictedWinner;
                          return (
                            <tr key={`${e.atIso}-${idx}-${e.predictedWinner}`}>
                              <td className="prediction-history-idx">{idx + 1}</td>
                              <td className="prediction-history-time">{formatPredictionHistoryLocalTime(e.atIso)}</td>
                              <td className="prediction-history-from">{fromLabel}</td>
                              <td className="prediction-history-team">{toLabel}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}
            {matchNotifyModal && (
              <div
                className="modal-overlay"
                role="dialog"
                aria-modal="true"
                aria-labelledby="match-notify-modal-title"
                onClick={() => !matchNotifySending && setMatchNotifyModal(null)}
              >
                <div className="match-notify-modal" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-content">
                    <div className="modal-header">
                      <h3 id="match-notify-modal-title">
                        Send notification — {getTeamCode(matchNotifyModal.match?.team1, teams)} vs {getTeamCode(matchNotifyModal.match?.team2, teams)}
                      </h3>
                      <button
                        type="button"
                        className="modal-close"
                        onClick={() => !matchNotifySending && setMatchNotifyModal(null)}
                        aria-label="Close"
                      >
                        &times;
                      </button>
                    </div>
                    <p className="muted" style={{ marginTop: 0 }}>
                      {(matchNotifyModal.match?.date || '')} · {formatMatchTime(matchNotifyModal.match?.time || matchNotifyModal.match?.slot)}
                      {' · '}
                      Only users with a ticked checkbox receive the push. Tap Send to selected users—nothing is queued.
                      Tapping the notification opens this match on the dashboard.
                    </p>
                    <div className="form-group">
                      <label htmlFor="match-notify-title">Title</label>
                      <input
                        id="match-notify-title"
                        type="text"
                        value={matchNotifyTitle}
                        onChange={(e) => setMatchNotifyTitle(e.target.value)}
                        placeholder="e.g. Reminder: predict before cutoff"
                        maxLength={120}
                        style={{ width: '100%', boxSizing: 'border-box', padding: '0.5rem 0.75rem', borderRadius: 8, border: '1px solid var(--border)' }}
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="match-notify-body">Message</label>
                      <textarea
                        id="match-notify-body"
                        value={matchNotifyBody}
                        onChange={(e) => setMatchNotifyBody(e.target.value)}
                        placeholder="Short message body…"
                        rows={3}
                        maxLength={500}
                      />
                    </div>
                    <div className="form-group">
                      <span id="match-notify-users-label">Recipients (checked only)</span>
                      <p className="muted" style={{ margin: '0.25rem 0 0.5rem', fontSize: '0.9rem' }}>
                        Tick who should get this push, then use the button below. Only ticked users are notified—never everyone at once unless you choose Select all.
                      </p>
                      <div className="notify-quick-select" style={{ marginTop: '0.5rem' }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            setMatchNotifyUserIds(
                              matchNotifyEligibleUsers.map((u) => String(u.id ?? u.uid ?? '').trim()).filter(Boolean)
                            )
                          }
                          disabled={matchNotifySending}
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setMatchNotifyUserIds([])}
                          disabled={matchNotifySending}
                        >
                          Clear
                        </button>
                      </div>
                      <p className="muted" style={{ marginTop: '0.35rem', fontSize: '0.9rem' }}>
                        {matchNotifyUserIds.length} user(s) will receive the push · {matchNotifyEligibleUsers.length} listed
                      </p>
                      <ul className="notify-user-list" aria-labelledby="match-notify-users-label" role="list">
                        {matchNotifyEligibleUsers.map((u) => {
                          const rowId = String(u.id ?? u.uid ?? '').trim();
                          if (!rowId) return null;
                          const isChecked = matchNotifyUserIds.some((x) => String(x) === rowId);
                          return (
                          <li key={rowId} className="match-notify-user-row">
                            <label className="match-notify-user-label" htmlFor={`match-notify-cb-${rowId}`}>
                              <input
                                id={`match-notify-cb-${rowId}`}
                                type="checkbox"
                                checked={isChecked}
                                onChange={(e) => setMatchNotifyUserChecked(rowId, e.target.checked)}
                                disabled={matchNotifySending}
                              />
                              <span>{toInitCap((u.username || u.email || 'User').toString().replace(/_/g, ' '))}</span>
                              <span className="muted notify-user-email">{u.email || rowId}</span>
                            </label>
                          </li>
                          );
                        })}
                      </ul>
                    </div>
                    <div className="modal-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => !matchNotifySending && setMatchNotifyModal(null)}
                        disabled={matchNotifySending}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleSendMatchNotifications}
                        disabled={matchNotifySending || matchNotifyUserIds.length === 0}
                      >
                        {matchNotifySending
                          ? 'Sending…'
                          : matchNotifyUserIds.length === 1
                            ? 'Send to 1 selected user'
                            : `Send to ${matchNotifyUserIds.length} selected users`}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {answerModalQuestion && (
              <div className="modal-overlay" onClick={() => !submittingAnswer && setAnswerModalQuestion(null)}>
                <div className="modal-content" onClick={e => e.stopPropagation()}>
                  <div className="modal-header">
                    <h3>
                      {answerModalQuestion.correctAnswer != null && String(answerModalQuestion.correctAnswer).trim() !== ''
                        ? 'Change correct answer'
                        : 'Set correct answer (after match completes)'}
                    </h3>
                    <button type="button" className="modal-close" onClick={() => !submittingAnswer && setAnswerModalQuestion(null)} aria-label="Close">&times;</button>
                  </div>
                  <p className="muted">{answerModalQuestion.question}</p>
                  {answerModalQuestion.correctAnswer != null && String(answerModalQuestion.correctAnswer).trim() !== '' && (
                    <p className="muted" style={{ marginTop: '0.35rem' }}>
                      Current official answer: <strong>{String(answerModalQuestion.correctAnswer).trim()}</strong>
                    </p>
                  )}
                  <form onSubmit={handleCorrectAnswerFormSubmit}>
                    <div className="form-group">
                      <label>Correct Answer</label>
                      {answerModalQuestion.type === 'yesno' && (
                        <select value={correctAnswerInput} onChange={e => setCorrectAnswerInput(e.target.value)} required>
                          <option value="Yes">Yes</option>
                          <option value="No">No</option>
                        </select>
                      )}
                      {answerModalQuestion.type === 'multiple' && (
                        <select value={correctAnswerInput} onChange={e => setCorrectAnswerInput(e.target.value)} required>
                          {(answerModalQuestion.options || []).map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      )}
                      {answerModalQuestion.type === 'text' && (
                        <input
                          type="text"
                          value={correctAnswerInput}
                          onChange={e => setCorrectAnswerInput(e.target.value)}
                          placeholder="Enter correct answer"
                          required
                        />
                      )}
                    </div>
                    <div className="modal-actions">
                      <button type="submit" className="btn btn-primary" disabled={submittingAnswer}>
                        {submittingAnswer
                          ? 'Submitting...'
                          : answerModalQuestion.correctAnswer != null &&
                              String(answerModalQuestion.correctAnswer).trim() !== ''
                            ? 'Save & reconcile insight points'
                            : 'Submit answer & award points'}
                      </button>
                      <button type="button" className="btn btn-secondary" onClick={() => setAnswerModalQuestion(null)} disabled={submittingAnswer}>Cancel</button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </section>
          )}

          {setPasswordUser && (
            <div
              className="modal-overlay"
              role="dialog"
              aria-modal="true"
              aria-labelledby="admin-set-password-title"
              onClick={() => !adminSetPasswordLoading && setSetPasswordUser(null)}
            >
              <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <h3 id="admin-set-password-title">Set password</h3>
                  <button
                    type="button"
                    className="modal-close"
                    onClick={() => !adminSetPasswordLoading && setSetPasswordUser(null)}
                    aria-label="Close"
                  >
                    &times;
                  </button>
                </div>
                <p className="muted">
                  User: <strong>{toInitCap(setPasswordUser.username || setPasswordUser.email || 'User')}</strong>
                  {setPasswordUser.email ? ` (${setPasswordUser.email})` : ''}
                </p>
                <form onSubmit={handleAdminSetUserPasswordSubmit} className="account-form">
                  <div className="form-group">
                    <label htmlFor="admin-new-pw">New password</label>
                    <input
                      id="admin-new-pw"
                      type="password"
                      value={adminSetPasswordNew}
                      onChange={(e) => setAdminSetPasswordNew(e.target.value)}
                      placeholder="Min 6 characters"
                      minLength={6}
                      autoComplete="new-password"
                      required
                      disabled={adminSetPasswordLoading}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="admin-confirm-pw">Confirm password</label>
                    <input
                      id="admin-confirm-pw"
                      type="password"
                      value={adminSetPasswordConfirm}
                      onChange={(e) => setAdminSetPasswordConfirm(e.target.value)}
                      placeholder="Confirm new password"
                      minLength={6}
                      autoComplete="new-password"
                      required
                      disabled={adminSetPasswordLoading}
                    />
                  </div>
                  <div className="modal-actions">
                    <button type="submit" className="btn btn-primary" disabled={adminSetPasswordLoading}>
                      {adminSetPasswordLoading ? 'Saving…' : 'Save password'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={adminSetPasswordLoading}
                      onClick={() => setSetPasswordUser(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
        )}
      </main>
    </div>
  );
}
