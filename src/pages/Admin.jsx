import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { collection, addDoc, getDocs, getDoc, doc, setDoc, updateDoc, deleteDoc, query, where, increment, runTransaction } from 'firebase/firestore';
import { db } from '../firebase/config';
import Sidebar from '../components/Sidebar';
import { toInitCap } from '../utils/format';
import { calculateMatchPoints } from '../utils/points';

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
    matches.push({
      matchNumber: matchNumber || String(i + 1),
      team1,
      team2,
      date,
      time: /^\d{1,2}:\d{2}$/.test(time) ? time : '19:00',
      thresholdTime: /^\d{1,2}:\d{2}$/.test(thresholdTime) ? thresholdTime : '18:00',
      status: status || 'open',
    });
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
    matchNumber: '',
    team1: '',
    team2: '',
    date: '',
    time: '19:00',
    thresholdTime: '18:00',
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
  const [cricketInsightsConfig, setCricketInsightsConfig] = useState({
    enabled: true,
    maxQuestionsPerUserPerMatch: 1,
    maxQuestionsPerMatch: 5,
    insightApproverIds: [],
    requiredApprovals: 1,
  });
  const [usernameLookupList, setUsernameLookupList] = useState([]);
  const [calculatingMatchId, setCalculatingMatchId] = useState(null);
  const [removingUserId, setRemovingUserId] = useState(null);
  const [removingRuleId, setRemovingRuleId] = useState(null);
  const [editingRule, setEditingRule] = useState(null);
  const [allUsers, setAllUsers] = useState([]);
  const [usersFetchError, setUsersFetchError] = useState(null);
  const [pendingQuestions, setPendingQuestions] = useState([]);
  const [questionsAwaitingAnswer, setQuestionsAwaitingAnswer] = useState([]);
  const [insightApprovalLoading, setInsightApprovalLoading] = useState(false);
  const [approvingQid, setApprovingQid] = useState(null);
  const [rejectingQid, setRejectingQid] = useState(null);
  const [removingQid, setRemovingQid] = useState(null);
  const [answerModalQuestion, setAnswerModalQuestion] = useState(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [correctAnswerInput, setCorrectAnswerInput] = useState('');
  const [submittingAnswer, setSubmittingAnswer] = useState(false);
  const [expandedInsightMatchId, setExpandedInsightMatchId] = useState(null);

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

      const today = new Date();
      setMatchForm(prev => ({
        ...prev,
        date: prev.date || today.toISOString().split('T')[0],
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
        const [pendingSnap, awaitingSnap] = await Promise.all([
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
        ]);
        setPendingQuestions(pendingSnap.docs.map(d => ({ id: d.id, ...d.data() })));
        setQuestionsAwaitingAnswer(awaitingSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      } catch (err) {
        console.error('Fetch insight questions error:', err);
        setMessage('Error loading questions: ' + (err.message || ''));
      }
      setInsightApprovalLoading(false);
    };
    fetchInsightQuestions();
  }, [activeSection]);

  useAutoDismiss(message, setMessage);

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

  const handleSetCorrectAnswer = async (e) => {
    e.preventDefault();
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
      const winners = answersSnap.docs
        .map(d => ({ ...d.data(), id: d.id }))
        .filter(a => String(a.answer || '').trim().toLowerCase() === correctAnswerNorm);
      for (const w of winners) {
        const uid = w.userId;
        if (!uid) continue;
        await updateDoc(doc(db, 'users', uid), { insightPoints: increment(1) });
      }
      setAnswerModalQuestion(null);
      setCorrectAnswerInput('');
      setMessage(`Correct answer set. ${winners.length} user(s) who answered correctly awarded +1 insight point.`);
      setQuestionsAwaitingAnswer(prev => prev.filter(p => p.id !== q.id));
    } catch (err) {
      setMessage('Error setting answer: ' + (err.message || ''));
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
    } catch (err) {
      setMessage('Error removing: ' + (err.message || ''));
    }
    setRemovingQid(null);
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
      for (const m of result.matches) {
        await addDoc(collection(db, 'matches'), {
          ...m,
          createdBy: user.uid,
          createdAt: new Date().toISOString(),
        });
      }
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
    try {
      await addDoc(collection(db, 'matches'), {
        matchNumber,
        team1: matchForm.team1,
        team2: matchForm.team2,
        date: matchForm.date,
        time: matchForm.time || '19:00',
        thresholdTime: matchForm.thresholdTime || '18:00',
        status: 'open',
        createdBy: user.uid,
        createdAt: new Date().toISOString(),
      });
      setMatchForm(prev => ({ matchNumber: '', team1: '', team2: '', date: prev.date, time: '19:00', thresholdTime: '18:00' }));
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
    setEditingMatch({
      id: match.id,
      matchNumber: match.matchNumber || '',
      team1: match.team1 || '',
      team2: match.team2 || '',
      date: match.date || '',
      time,
      thresholdTime,
      status: match.status || 'open',
      winner: match.winner || '',
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
    try {
      await updateDoc(doc(db, 'matches', editingMatch.id), {
        matchNumber: (editingMatch.matchNumber || '').toString().trim(),
        team1: editingMatch.team1,
        team2: editingMatch.team2,
        date: editingMatch.date,
        time: editingMatch.time,
        thresholdTime: editingMatch.thresholdTime,
        status: editingMatch.status || 'open',
        winner: editingMatch.winner || null,
      });
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
      setMessage(`Points calculated and saved. Winners: ${s.winners ?? 0}, Wrong: ${s.wrong ?? 0}, Not participated: ${s.notParticipated ?? 0}`);
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

  const handleSaveProgramConfig = async (e) => {
    e.preventDefault();
    try {
      const notParticipated = Math.abs(Number(pointRules.notParticipatedPoints) || 7);
      const wrongPrediction = Math.abs(Number(pointRules.wrongPredictionPoints) || 5);
      const max = Math.max(1, Math.min(100, parseInt(passwordPolicy.maxPasswordChanges, 10) || 2));
      const deadline = (passwordPolicy.surrenderDeadline || '').trim();
      const maxPerUser = Math.max(1, Math.min(10, parseInt(cricketInsightsConfig.maxQuestionsPerUserPerMatch, 10) || 1));
      const maxPerMatch = Math.max(1, Math.min(20, parseInt(cricketInsightsConfig.maxQuestionsPerMatch, 10) || 5));
      await Promise.all([
        setDoc(doc(db, 'rules', 'pointRules'), {
          notParticipatedPoints: notParticipated,
          wrongPredictionPoints: wrongPrediction,
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
      setPasswordPolicy(prev => ({ ...prev, maxPasswordChanges: max, surrenderDeadline: deadline }));
      setCricketInsightsConfig(prev => ({ ...prev, enabled: cricketInsightsConfig.enabled, maxQuestionsPerUserPerMatch: maxPerUser, maxQuestionsPerMatch: maxPerMatch }));
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
            <div className="alert alert-success">
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
            <h2>Users</h2>
            <p className="muted">Remove users to revoke app access. Admins cannot remove themselves. Firebase Auth account may need to be deleted manually from Firebase Console.</p>
            {usersFetchError ? (
              <p className="alert alert-error">{usersFetchError}</p>
            ) : allUsers.length === 0 ? (
              <p className="no-matches">No users found.</p>
            ) : (
              <ul className="rules-list">
                {allUsers
                  .filter(u => u.id !== user?.uid)
                  .sort((a, b) => (a.username || a.email || '').localeCompare(b.username || b.email || ''))
                  .map(u => (
                    <li key={u.id} className="user-list-item">
                      <span>{toInitCap(u.username || u.email || 'User')}</span>
                      <span className="muted"> ({u.email || u.id})</span>
                      {u.isAdmin && <span className="badge-admin">Admin</span>}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleRemoveUser(u)}
                        disabled={removingUserId === u.id}
                      >
                        {removingUserId === u.id ? 'Removing...' : 'Remove'}
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </section>
          )}

          {activeSection === 'matches' && (
          <section id="section-matches" className="admin-section">
            <h3>Import Matches (bulk)</h3>
            <div className="import-players-section">
              <h5>Paste JSON array</h5>
              <p className="import-hint">Paste a JSON array of matches. Include <strong>matchId</strong> (or matchNumber) for each. Format: <code>[{'{'} "matchId": "1", "team1": "PUNJAB KINGS", "team2": "GUJARAT TITANS", "date": "2026-03-31", "time": "19:30", "thresholdTime": "19:00", "status": "open" {'}'}, ...]</code></p>
              <textarea
                value={importMatchJsonText}
                onChange={(e) => { setImportMatchJsonText(e.target.value); setImportMatchError(''); }}
                placeholder={`[\n  { "matchId": "1", "team1": "PUNJAB KINGS", "team2": "GUJARAT TITANS", "date": "2026-03-31", "time": "19:30", "thresholdTime": "19:00", "status": "open" },\n  { "matchId": "2", "team1": "MI", "team2": "CSK", "date": "2026-04-01", ... },\n  ...\n]`}
                className="import-json-textarea"
                rows={5}
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
                  {editingMatch && (
                    <form onSubmit={handleUpdateMatch} className="match-form edit-form">
                      <h4>Edit Match</h4>
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
                    const hasInsights = matchPending.length > 0 || matchAwaiting.length > 0;
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
                        {m.matchNumber && <span className="match-id-badge">#{m.matchNumber}</span>}
                        <span className="match-teams">{getTeamCode(m.team1, teams)} vs {getTeamCode(m.team2, teams)}</span>
                        <span className="match-meta">{m.date} · {formatMatchTime(m.time || m.slot)}</span>
                        {m.winner && <span className="match-winner">Winner: {getTeamCode(m.winner, teams)}</span>}
                        <span className={`match-status ${(m.status || 'open').toLowerCase() === 'completed' ? 'completed' : m.date === new Date().toISOString().split('T')[0] ? 'today' : 'open'}`}>
                        {(m.status || 'open').toLowerCase() === 'completed'
                          ? 'completed'
                          : m.date === new Date().toISOString().split('T')[0]
                            ? 'today'
                            : 'upcoming'}
                      </span>
                      </div>
                      <div className="match-actions">
                        {(m.status || '').toLowerCase() === 'completed' && m.winner && (
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
                        <button
                          type="button"
                          className={`btn btn-sm btn-insight btn-icon-only ${isInsightExpanded ? 'active' : ''}`}
                          onClick={() => setExpandedInsightMatchId(isInsightExpanded ? null : m.id)}
                          title="Insight approval (visible to admin only)"
                          aria-label="Insight approval"
                        >
                          <span className="btn-insight-count">{matchPending.length + matchAwaiting.length}</span>
                          💡
                        </button>
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
                              {matchAwaiting.length > 0 && (
                                <div className="insight-subsection">
                                  <h4>Set correct answer (after match completes)</h4>
                                  {(m.status || '').toLowerCase() !== 'completed' && (
                                    <p className="muted" style={{ marginBottom: '0.5rem' }}>Mark the match as completed first, then you can submit the correct answer.</p>
                                  )}
                                  <ul className="rules-list">
                                    {matchAwaiting.map(q => (
                                      <li key={q.id} className="insight-pending-item">
                                        <div className="insight-pending-content">
                                          <strong>{q.question}</strong>
                                          <span className="muted"> · {q.type === 'yesno' ? 'Yes/No' : q.type === 'multiple' ? 'Multiple Choice' : 'Text'}</span>
                                          {(q.options || []).length > 0 && (
                                            <p className="muted" style={{ margin: '0.25rem 0 0 0' }}>Options: {q.options.join(', ')}</p>
                                          )}
                                        </div>
                                        <div className="insight-pending-actions">
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
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {matchPending.length === 0 && matchAwaiting.length === 0 && (
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
            {answerModalQuestion && (
              <div className="modal-overlay" onClick={() => !submittingAnswer && setAnswerModalQuestion(null)}>
                <div className="modal-content" onClick={e => e.stopPropagation()}>
                  <div className="modal-header">
                    <h3>Set Correct Answer (after match completes)</h3>
                    <button type="button" className="modal-close" onClick={() => !submittingAnswer && setAnswerModalQuestion(null)} aria-label="Close">&times;</button>
                  </div>
                  <p className="muted">{answerModalQuestion.question}</p>
                  <form onSubmit={handleSetCorrectAnswer}>
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
                        {submittingAnswer ? 'Submitting...' : 'Submit Answer & Award Points'}
                      </button>
                      <button type="button" className="btn btn-secondary" onClick={() => setAnswerModalQuestion(null)} disabled={submittingAnswer}>Cancel</button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </section>
          )}
        </div>
        )}
      </main>
    </div>
  );
}
