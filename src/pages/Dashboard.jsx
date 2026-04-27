import { useState, useEffect, useReducer } from 'react';
import { createPortal } from 'react-dom';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { useLocation, useSearchParams } from 'react-router-dom';
import CricketInsights from '../components/CricketInsights';
import InsightHistoryModalContent from '../components/InsightHistoryModalContent';
import CumulativePointsLineChart from '../components/CumulativePointsLineChart';
import PredictionContextsUserPanel from '../components/PredictionContextsUserPanel';
import MyChallengePointsPanel from '../components/MyChallengePointsPanel';
import { useAuth } from '../context/AuthContext';
import { collection, query, where, getDocs, getDoc, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase/config';
import Sidebar from '../components/Sidebar';
import { toInitCap, formatDdMmYyyy } from '../utils/format';
import { getAppTodayDate } from '../utils/calendarDate';
import {
  calculateLeaderboard,
  expectedPointsIfWinner,
  to2Decimals,
  sumSeasonContestLeaderboardPoints,
} from '../utils/points';
import { isPredictionEligible, shouldShowCrowdPrediction } from '../utils/match';
import { getPredictionSavedIso, formatTimeHH24 } from '../utils/predictionTime';
import { resolvePredictionChangeLogForPersist } from '../utils/predictionChangeLog';
import {
  isMatchCompletedWithResult,
  hasTeamWinnerForScoring,
  getMatchResultLabel,
  isDrawOrCancelledWinner,
} from '../utils/matchOutcomes';
import {
  getInsightWrongAnswerPenalty,
  buildInsightRecalcFromSnapshots,
  computeRecalculatedInsightTotalsByUser,
  insightMatchNetPoints,
} from '../utils/insightScoring';

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

function isUserPredictionApproved(userProfile) {
  return userProfile?.predictionApproved === true || userProfile?.predictionApproved === 'true';
}

/** Schedule order: date, then match number, then time (fixes same-day double-headers and point history). */
function sortMatchesChronological(list) {
  if (!list || list.length === 0) return [];
  return [...list].sort((a, b) => {
    const cmpDate = (a.date || '').localeCompare(b.date || '');
    if (cmpDate !== 0) return cmpDate;
    const matchNumA = parseInt(String(a.matchNumber || '0'), 10);
    const matchNumB = parseInt(String(b.matchNumber || '0'), 10);
    const na = Number.isNaN(matchNumA) ? 0 : matchNumA;
    const nb = Number.isNaN(matchNumB) ? 0 : matchNumB;
    if (na !== nb) return na - nb;
    const timeA = String(a.time || a.slot || '00:00').padStart(5, '0');
    const timeB = String(b.time || b.slot || '00:00').padStart(5, '0');
    return timeA.localeCompare(timeB);
  });
}

/** Newest / highest match first: date descending, match number descending, time descending. */
function sortMatchesDescending(list) {
  if (!list || list.length === 0) return [];
  return [...list].sort((a, b) => {
    const cmpDate = (b.date || '').localeCompare(a.date || '');
    if (cmpDate !== 0) return cmpDate;
    const matchNumA = parseInt(String(a.matchNumber || '0'), 10);
    const matchNumB = parseInt(String(b.matchNumber || '0'), 10);
    const na = Number.isNaN(matchNumA) ? 0 : matchNumA;
    const nb = Number.isNaN(matchNumB) ? 0 : matchNumB;
    if (na !== nb) return nb - na;
    const timeA = String(a.time || a.slot || '00:00').padStart(5, '0');
    const timeB = String(b.time || b.slot || '00:00').padStart(5, '0');
    return timeB.localeCompare(timeA);
  });
}

/**
 * Match history list order. Single-date filter: newest first (unchanged).
 * All dates: incomplete matches first (ascending schedule), then completed matches (ascending).
 */
function sortHistoryMatchesForDisplay(list, allDatesMode) {
  if (!list || list.length === 0) return [];
  if (!allDatesMode) return sortMatchesDescending(list);
  const incomplete = list.filter((m) => !isMatchCompletedWithResult(m));
  const complete = list.filter((m) => isMatchCompletedWithResult(m));
  return [...sortMatchesChronological(incomplete), ...sortMatchesChronological(complete)];
}

/**
 * Last completed match day strictly before the selected date (for “previous” rank).
 * If no date is selected (“All dates”), the boundary is the final completed day, so “previous”
 * means standings through the last match before that final day.
 */
function getPreviousMatchCutoffDate(allMatches, selectedDate) {
  const completed = sortMatchesChronological(
    (allMatches || []).filter(isMatchCompletedWithResult)
  );
  if (completed.length === 0) return '';
  const endExclusive = selectedDate && String(selectedDate).trim()
    ? String(selectedDate).trim()
    : (completed[completed.length - 1].date || '').trim();
  const before = completed.filter((m) => (m.date || '') < endExclusive);
  if (before.length === 0) return '';
  return (before[before.length - 1].date || '').trim();
}

function getCompletedMatchesSorted(allMatches) {
  return sortMatchesChronological((allMatches || []).filter(isMatchCompletedWithResult));
}

function hasCompletedMatchOnDate(allMatches, dateStr) {
  if (!dateStr) return false;
  const d = String(dateStr).trim();
  return (allMatches || []).some(
    (m) => isMatchCompletedWithResult(m) && (m.date || '').trim() === d
  );
}

/**
 * When today is selected but no match is completed today, Previous rank uses all completed
 * matches except the chronologically last one (one match earlier than “last completed”).
 */
function getPreviousRankContext(allMatches, leaderboardDate) {
  const today = getAppTodayDate();
  const selected = (leaderboardDate || '').trim();
  if (selected && selected === today && !hasCompletedMatchOnDate(allMatches, today)) {
    const allSorted = getCompletedMatchesSorted(allMatches);
    if (allSorted.length >= 2) {
      const withoutLast = allSorted.slice(0, -1);
      const cutoffLabel = (withoutLast[withoutLast.length - 1].date || '').trim();
      return {
        excludeLastCompletedMatch: true,
        completedSubset: withoutLast,
        cutoffLabel,
      };
    }
    return { excludeLastCompletedMatch: true, completedSubset: [], cutoffLabel: '' };
  }
  const cutoff = getPreviousMatchCutoffDate(allMatches, leaderboardDate || '');
  return { excludeLastCompletedMatch: false, completedSubset: null, cutoffLabel: cutoff };
}

function computeRankedMainLeaderboard(
  allMatches,
  users,
  predsByMatch,
  pointRules,
  matchStartDate,
  dateCutoff,
  completedMatchesOverride
) {
  let completedMatches;
  if (Array.isArray(completedMatchesOverride)) {
    completedMatches = sortMatchesChronological(completedMatchesOverride.slice());
  } else {
    completedMatches = allMatches.filter(isMatchCompletedWithResult);
    if (dateCutoff) {
      completedMatches = completedMatches.filter((m) => (m.date || '') <= dateCutoff);
    }
    completedMatches = sortMatchesChronological(completedMatches);
  }
  const totals = calculateLeaderboard(completedMatches, users, predsByMatch, pointRules);
  let sortedByPoints = users
    .map((u) => ({
      ...u,
      points: totals[u.id] ?? 0,
    }))
    .sort((a, b) => {
      const pb = b.points ?? 0;
      const pa = a.points ?? 0;
      if (pb !== pa) return pb - pa;
      return compareLeaderboardUsers(a, b);
    });
  if (matchStartDate && sortedByPoints.length > 0) {
    const bottomPoints = sortedByPoints[sortedByPoints.length - 1].points ?? 0;
    sortedByPoints = sortedByPoints
      .map((u) => {
        const createdAtDate = (u.createdAt || '').toString().split('T')[0];
        const isLateUser =
          createdAtDate &&
          createdAtDate >= matchStartDate &&
          !isUserPredictionApproved(u);
        const matchPts = isLateUser ? bottomPoints : (u.points ?? 0);
        const seasonExtra = sumSeasonContestLeaderboardPoints(u);
        return {
          ...u,
          points: to2Decimals(matchPts + seasonExtra),
          isLateUser,
        };
      })
      .sort((a, b) => {
        const pb = b.points ?? 0;
        const pa = a.points ?? 0;
        if (pb !== pa) return pb - pa;
        return compareLeaderboardUsers(a, b);
      });
  } else {
    sortedByPoints = sortedByPoints.map((u) => ({
      ...u,
      points: to2Decimals((u.points ?? 0) + sumSeasonContestLeaderboardPoints(u)),
    }));
  }
  let rank = 1;
  return sortedByPoints.map((u, i) => {
    if (i > 0 && (sortedByPoints[i - 1].points ?? 0) > (u.points ?? 0)) rank += 1;
    return { ...u, rank };
  });
}

/**
 * Insight leaderboard: same net points as the per-user insight history modal (Q&A + penalty),
 * only counting completed matches through dateCutoff. Falls back to summing match.insightPointResults if recalc data missing.
 */
function computeInsightRanked(users, allMatches, dateCutoff, insightRecalc) {
  let insightMatches = allMatches.filter(isMatchCompletedWithResult);
  if (dateCutoff) {
    insightMatches = insightMatches.filter((m) => (m.date || '') <= dateCutoff);
  }
  insightMatches = sortMatchesChronological(insightMatches);

  /** @type {Record<string, number>} */
  let insightTotals = {};
  users.forEach((u) => {
    insightTotals[u.id] = 0;
  });

  const canRecalc =
    insightRecalc?.questionsByMatchId &&
    insightRecalc?.answersByUserId != null &&
    insightRecalc.penalty != null &&
    !Number.isNaN(Number(insightRecalc.penalty));

  if (canRecalc) {
    insightTotals = computeRecalculatedInsightTotalsByUser(
      users,
      insightMatches,
      insightRecalc.questionsByMatchId,
      insightRecalc.answersByUserId,
      insightRecalc.penalty
    );
  } else {
    insightMatches.forEach((m) => {
      const ir = m.insightPointResults;
      if (ir && typeof ir === 'object') {
        Object.entries(ir).forEach(([uid, pts]) => {
          insightTotals[uid] = to2Decimals((insightTotals[uid] || 0) + Number(pts || 0));
        });
      }
    });
  }

  const sortedByInsight = [...users]
    .map((u) => ({ ...u, insightPoints: insightTotals[u.id] ?? 0 }))
    .sort((a, b) => {
      const ib = b.insightPoints ?? 0;
      const ia = a.insightPoints ?? 0;
      if (ib !== ia) return ib - ia;
      return compareLeaderboardUsers(a, b);
    });
  let rank = 1;
  return sortedByInsight.map((u, i) => {
    if (i > 0 && (sortedByInsight[i - 1].insightPoints ?? 0) > (u.insightPoints ?? 0)) rank += 1;
    return { ...u, rank };
  });
}

function computeInsightRankedFromMatches(users, matchesSubset, insightRecalc) {
  let insightMatches = Array.isArray(matchesSubset) ? matchesSubset.filter(isMatchCompletedWithResult) : [];
  insightMatches = sortMatchesChronological(insightMatches);

  /** @type {Record<string, number>} */
  let insightTotals = {};
  users.forEach((u) => {
    insightTotals[u.id] = 0;
  });

  const canRecalc =
    insightRecalc?.questionsByMatchId &&
    insightRecalc?.answersByUserId != null &&
    insightRecalc.penalty != null &&
    !Number.isNaN(Number(insightRecalc.penalty));

  if (canRecalc) {
    insightTotals = computeRecalculatedInsightTotalsByUser(
      users,
      insightMatches,
      insightRecalc.questionsByMatchId,
      insightRecalc.answersByUserId,
      insightRecalc.penalty
    );
  } else {
    insightMatches.forEach((m) => {
      const ir = m.insightPointResults;
      if (ir && typeof ir === 'object') {
        Object.entries(ir).forEach(([uid, pts]) => {
          insightTotals[uid] = to2Decimals((insightTotals[uid] || 0) + Number(pts || 0));
        });
      }
    });
  }

  const sortedByInsight = [...users]
    .map((u) => ({ ...u, insightPoints: insightTotals[u.id] ?? 0 }))
    .sort((a, b) => {
      const ib = b.insightPoints ?? 0;
      const ia = a.insightPoints ?? 0;
      if (ib !== ia) return ib - ia;
      return compareLeaderboardUsers(a, b);
    });
  let rank = 1;
  return sortedByInsight.map((u, i) => {
    if (i > 0 && (sortedByInsight[i - 1].insightPoints ?? 0) > (u.insightPoints ?? 0)) rank += 1;
    return { ...u, rank };
  });
}

/**
 * Per-user match winner pick stats (not points). Ranked by most correct picks.
 * Draw/cancelled matches increment drawCount only; team-winner matches split into correct / wrong / not predicted.
 */
function computeMatchPickStatsRanked(users, allMatches, predsByMatch, dateCutoff) {
  let completed = (allMatches || []).filter(isMatchCompletedWithResult);
  if (dateCutoff) {
    completed = completed.filter((m) => (m.date || '') <= dateCutoff);
  }
  completed = sortMatchesChronological(completed);

  const stats = {};
  (users || []).forEach((u) => {
    stats[u.id] = { correct: 0, wrong: 0, notPredicted: 0, draw: 0 };
  });

  completed.forEach((match) => {
    const winner = (match.winner || '').trim();
    if (isDrawOrCancelledWinner(winner)) {
      (users || []).forEach((u) => {
        stats[u.id].draw += 1;
      });
      return;
    }
    const winnerNorm = winner.toLowerCase().trim();
    const preds = predsByMatch[match.id] || [];
    const predMap = new Map();
    preds.forEach((p) => predMap.set(p.userId, p.predictedWinner));

    (users || []).forEach((u) => {
      const uid = u.id;
      const predicted = predMap.get(uid);
      const predNorm = (predicted || '').toLowerCase().trim();
      if (!predicted) {
        stats[uid].notPredicted += 1;
      } else if (predNorm === winnerNorm) {
        stats[uid].correct += 1;
      } else {
        stats[uid].wrong += 1;
      }
    });
  });

  const sorted = [...(users || [])]
    .map((u) => ({
      ...u,
      pickCorrect: stats[u.id].correct,
      pickWrong: stats[u.id].wrong,
      pickNotPredicted: stats[u.id].notPredicted,
      pickDraw: stats[u.id].draw,
    }))
    .sort((a, b) => {
      const cb = b.pickCorrect ?? 0;
      const ca = a.pickCorrect ?? 0;
      if (cb !== ca) return cb - ca;
      return compareLeaderboardUsers(a, b);
    });

  let rank = 1;
  return sorted.map((u, i) => {
    if (i > 0 && (sorted[i - 1].pickCorrect ?? 0) > (u.pickCorrect ?? 0)) rank += 1;
    return { ...u, rank };
  });
}

/** Counts predictions per team (and "other") for crowd % (shown whenever data exists). */
/**
 * @param {number|null|undefined} participatingUserCount - non-admin users (denominator for no-pred %).
 */
function getCrowdPredictionStats(match, predsForMatch, participatingUserCount) {
  const t1 = (match.team1 || '').trim().toLowerCase();
  const t2 = (match.team2 || '').trim().toLowerCase();
  const predictedUserIds = new Set();
  let c1 = 0;
  let c2 = 0;
  let other = 0;
  (predsForMatch || []).forEach((p) => {
    const w = (p.predictedWinner || '').trim().toLowerCase();
    if (!w) return;
    if (p.userId) predictedUserIds.add(p.userId);
    if (w === t1) c1 += 1;
    else if (w === t2) c2 += 1;
    else other += 1;
  });

  const eligible =
    typeof participatingUserCount === 'number' && participatingUserCount > 0
      ? participatingUserCount
      : null;

  if (eligible) {
    const noPred = Math.max(0, eligible - predictedUserIds.size);
    const pct = (n) => Math.round((n / eligible) * 100);
    return {
      team1Pct: pct(c1),
      team2Pct: pct(c2),
      otherPct: other > 0 ? pct(other) : 0,
      noPredictionPct: noPred > 0 ? pct(noPred) : 0,
      c1,
      c2,
      other,
      noPredictionCount: noPred,
      totalPicks: c1 + c2 + other,
      eligibleTotal: eligible,
    };
  }

  const total = c1 + c2 + other;
  if (total === 0) return null;
  const pct = (n) => Math.round((n / total) * 100);
  return {
    team1Pct: pct(c1),
    team2Pct: pct(c2),
    otherPct: other > 0 ? pct(other) : 0,
    noPredictionPct: 0,
    noPredictionCount: 0,
    c1,
    c2,
    other,
    totalPicks: total,
    eligibleTotal: null,
  };
}

function canUserPredict(userProfile, programConfig) {
  const matchStartDate = (programConfig?.matchStartDate || '').trim();
  if (!matchStartDate) return true;
  const createdAtDate = (userProfile?.createdAt || '').toString().split('T')[0];
  if (!createdAtDate) return true;
  if (createdAtDate < matchStartDate) return true;
  return isUserPredictionApproved(userProfile);
}

function getTeamCode(teamName, teams) {
  const t = teams.find(x => (x.name || '').toLowerCase() === (teamName || '').toLowerCase());
  return (t?.code || '').trim() || teamName || '';
}

function formatMatchVenue(match) {
  const stadium = (match?.stadium || '').trim();
  const city = (match?.city || '').trim();
  if (!stadium && !city) return null;
  if (stadium && city) return `${stadium} · ${city}`;
  return stadium || city;
}

function normalizePlayers(players) {
  if (!Array.isArray(players)) return [];
  return players.map(p => {
    if (typeof p === 'string') return { name: p, active: true, type: 'Batsman', role: 'player' };
    return { name: p?.name || '', active: p?.active !== false, type: p?.type || 'Batsman', role: p?.role || 'player' };
  });
}

const DASHBOARD_SECTION_IDS = ['dashboard', 'teams', 'rules', 'matches', 'qualifierPicks', 'leaderboard', 'account'];

/** Tie-break for leaderboard rows: username, then email, then id. */
function compareLeaderboardUsers(a, b) {
  const na = (a.username || a.email || a.id || '').toString();
  const nb = (b.username || b.email || b.id || '').toString();
  return na.localeCompare(nb, undefined, { sensitivity: 'base' });
}

/** Season challenge rows for leaderboard / point history modals (name + points only; no ids on UI). */
function SeasonChallengeLeaderboardHistoryList({ entries, intro }) {
  if (!entries?.length) return null;
  const text =
    intro ||
    'Season prediction challenges: points from your correct picks when an admin scores the challenge (included in the leaderboard total).';
  return (
    <>
      <p className="point-history-intro" style={{ marginTop: '1rem' }}>
        {text}
      </p>
      <div
        className="points-history-scroll point-history-scroll point-history-scroll--season-challenges"
        role="region"
        aria-label="Season challenge point history"
      >
        <ul className="point-history-cards point-history-cards--in-scroll">
          {entries.map(([contextId, row]) => {
            const pts = to2Decimals(Number(row?.points ?? 0));
            const name = (row?.title || '').trim() || 'Season prediction';
            return (
              <li key={contextId} className="point-history-card">
                <div className="point-history-card-head">
                  <span className="point-history-card-badge">Season challenge</span>
                </div>
                <p className="point-history-card-teams" style={{ fontSize: '0.95rem' }}>
                  {name}
                </p>
                <dl className="point-history-dl point-history-dl--season">
                  <div>
                    <dt>Points</dt>
                    <dd className={pts >= 0 ? 'points-positive' : 'points-negative'}>
                      {pts >= 0 ? '+' : ''}
                      {pts}
                    </dd>
                  </div>
                  {(row?.scoredAt || row?.declaredAt) && (
                    <div>
                      <dt>{row?.scoredAt ? 'Scored' : 'Declared'}</dt>
                      <dd className="muted">{formatDdMmYyyy(row.scoredAt || row.declaredAt)}</dd>
                    </div>
                  )}
                </dl>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

export default function Dashboard() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { user, userProfile, logout, surrenderAccount, getSurrenderDeadline, changePassword, updateUsername } = useAuth();
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
  const [matchFilterDate, setMatchFilterDate] = useState(() => getAppTodayDate());
  const [teams, setTeams] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [insightLeaderboard, setInsightLeaderboard] = useState([]);
  const [pickStatsLeaderboard, setPickStatsLeaderboard] = useState([]);
  const [leaderboardTab, setLeaderboardTab] = useState('main'); // main | pickStats | insights
  const [leaderboardDate, setLeaderboardDate] = useState(() => getAppTodayDate());
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
  const [cpNewPassword, setCpNewPassword] = useState('');
  const [cpConfirmPassword, setCpConfirmPassword] = useState('');
  const [cpLoading, setCpLoading] = useState(false);
  const [cpMessage, setCpMessage] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [usernameMessage, setUsernameMessage] = useState('');
  const [expandedInsightMatchId, setExpandedInsightMatchId] = useState(null);
  const [participantsModal, setParticipantsModal] = useState(null);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [showPointsHistoryModal, setShowPointsHistoryModal] = useState(false);
  const [showInsightHistoryModal, setShowInsightHistoryModal] = useState(false);
  const [showWinsLossesModal, setShowWinsLossesModal] = useState(false);
  const [showParticipatedModal, setShowParticipatedModal] = useState(false);
  const [showTodayMatchesModal, setShowTodayMatchesModal] = useState(false);
  const [showChallengePointsModal, setShowChallengePointsModal] = useState(false);
  const [cricketInsightsConfig, setCricketInsightsConfig] = useState({
    enabled: true,
    maxQuestionsPerUserPerMatch: 1,
    maxQuestionsPerMatch: 5,
    requiredApprovals: 1,
    insightWrongAnswerPenalty: 0.25,
    allowInsightQuestionsAfterPredictionCutoff: false,
    allowInsightAnswersAfterPredictionCutoff: false,
  });
  const [programConfig, setProgramConfig] = useState({
    matchStartDate: '',
    crowdPredictionVisibility: 'always',
    crowdPredictionMinutesAfterCutoff: 10,
  });
  const [insightQuestionCount, setInsightQuestionCount] = useState({});
  const [insightPointsByMatch, setInsightPointsByMatch] = useState({});
  /** matchId -> { userId, predictedWinner }[] for crowd % (all users) */
  const [crowdPredictionsByMatch, setCrowdPredictionsByMatch] = useState({});
  /** Non-admin user count; used for “did not predict” % (null = not loaded yet). */
  const [participatingUserCount, setParticipatingUserCount] = useState(null);
  /** Same non-admin users as leaderboard pool; used for expected winner points beside crowd %. */
  const [participatingUsersForScoring, setParticipatingUsersForScoring] = useState(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  /** Active prediction contexts where the user saved picks (Firestore responses); not tied to admin scoring. */
  const [challengeParticipatedCount, setChallengeParticipatedCount] = useState(null);
  const today = getAppTodayDate();
  /** Re-render periodically on the matches tab so crowd % appears when cutoff + delay elapses. */
  const [, bumpCrowdRevealTick] = useReducer((x) => x + 1, 0);

  useEffect(() => {
    if (activeSection !== 'matches') return;
    const id = setInterval(() => bumpCrowdRevealTick(), 30000);
    return () => clearInterval(id);
  }, [activeSection]);

  useEffect(() => {
    const section = location.state?.section;
    if (section && DASHBOARD_SECTION_IDS.includes(section)) {
      setActiveSection(section);
    }
  }, [location.state?.section]);

  /** Deep link from push: /dashboard?section=matches&focusMatch=<id> */
  useEffect(() => {
    const sec = searchParams.get('section');
    if (sec && DASHBOARD_SECTION_IDS.includes(sec)) {
      setActiveSection(sec);
    }
  }, [searchParams]);

  useEffect(() => {
    const focusMatchId = searchParams.get('focusMatch');
    if (!focusMatchId || loading || !allMatches.length) return;
    const m = allMatches.find((x) => String(x.id) === String(focusMatchId));
    if (!m) return;
    const isTodayCard = m.date === today;
    if (isTodayCard) {
      setActiveTab('today');
      setSelectedMatchFilter(m.id);
    } else {
      setActiveTab('history');
      if (m.date) setMatchFilterDate(m.date);
      setSelectedHistoryMatchFilter(m.id);
    }
  }, [searchParams, loading, allMatches, today]);

  useEffect(() => {
    if (activeSection === 'account' && user) {
      getSurrenderDeadline().then(setSurrenderDeadline);
    }
  }, [activeSection, user]);

  useAutoDismiss(surrenderError, setSurrenderError);
  useAutoDismiss(cpMessage, setCpMessage);
  useAutoDismiss(usernameMessage, setUsernameMessage);

  useEffect(() => {
    if (activeSection !== 'account' || !userProfile) return;
    const u = (userProfile.username || '').toString();
    setUsernameInput(u.replace(/_/g, ' ').trim());
  }, [activeSection, userProfile?.username]);

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
  const matchOptionsHistory = sortHistoryMatchesForDisplay(historyMatchList, !matchFilterDate)
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
  const historyMatches = sortHistoryMatchesForDisplay(historyMatchesFiltered, !matchFilterDate);

  useEffect(() => {
    const focusMatchId = searchParams.get('focusMatch');
    if (!focusMatchId || loading || activeSection !== 'matches') return;
    const el = document.getElementById(`match-${focusMatchId}`);
    if (!el) return;
    const id = window.setTimeout(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 200);
    return () => window.clearTimeout(id);
  }, [searchParams, loading, activeSection, activeTab, filteredMatches.length, historyMatches.length]);

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
        qSnap.docs.forEach((d) => {
          const data = d.data();
          const mid = data.matchId;
          const midKey = mid != null && String(mid).trim() !== '' ? String(mid).trim() : '';
          if (midKey) counts[midKey] = (counts[midKey] || 0) + 1;
        });
        setInsightQuestionCount(counts);

        const pointsByMatch = {};
        if (user?.uid) {
          try {
            const [aSnap, ptSnap, ciSnap] = await Promise.all([
              getDocs(query(collection(db, 'cricket_answers'), where('userId', '==', user.uid))),
              getDoc(doc(db, 'rules', 'pointRules')),
              getDoc(doc(db, 'settings', 'cricketInsights')).catch(() => null),
            ]);
            const rules = ptSnap.exists() ? ptSnap.data() : {};
            const ciData = ciSnap?.exists() ? ciSnap.data() : {};
            const penalty = getInsightWrongAnswerPenalty({
              cricketInsightsConfig: {
                insightWrongAnswerPenalty:
                  ciData.insightWrongAnswerPenalty != null && ciData.insightWrongAnswerPenalty !== ''
                    ? Number(ciData.insightWrongAnswerPenalty)
                    : undefined,
              },
              pointRules: rules,
            });

            const questionsByMatchId = {};
            qSnap.docs.forEach((d) => {
              const data = d.data();
              const mid = data.matchId;
              if (mid == null || String(mid).trim() === '') return;
              const key = String(mid).trim();
              if (!questionsByMatchId[key]) questionsByMatchId[key] = [];
              questionsByMatchId[key].push({ id: d.id, ...data });
            });

            const myAnswers = {};
            aSnap.docs.forEach((d) => {
              const x = d.data();
              const qid = x.questionId != null ? String(x.questionId) : '';
              if (qid) myAnswers[qid] = x.answer;
            });

            Object.keys(questionsByMatchId).forEach((mid) => {
              const net = insightMatchNetPoints(questionsByMatchId[mid], myAnswers, penalty);
              if (net !== 0) {
                pointsByMatch[mid] = net;
              }
            });
          } catch {
            /* ignore per-match insight totals */
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
            requiredApprovals: d.requiredApprovals ?? 1,
            insightWrongAnswerPenalty:
              d.insightWrongAnswerPenalty != null && d.insightWrongAnswerPenalty !== ''
                ? Number(d.insightWrongAnswerPenalty)
                : 0.25,
            allowInsightQuestionsAfterPredictionCutoff: d.allowInsightQuestionsAfterPredictionCutoff === true,
            allowInsightAnswersAfterPredictionCutoff: d.allowInsightAnswersAfterPredictionCutoff === true,
          });
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
            crowdPredictionVisibility: d.crowdPredictionVisibility === 'afterCutoff' ? 'afterCutoff' : 'always',
            crowdPredictionMinutesAfterCutoff:
              d.crowdPredictionMinutesAfterCutoff != null && d.crowdPredictionMinutesAfterCutoff !== ''
                ? Number(d.crowdPredictionMinutesAfterCutoff)
                : 10,
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
    if (!user || activeSection !== 'matches') return;
    let cancelled = false;
    (async () => {
      try {
        const [allPredSnap, usersSnap, ptSnap] = await Promise.all([
          getDocs(collection(db, 'predictions')),
          getDocs(collection(db, 'users')).catch(() => ({ docs: [] })),
          getDoc(doc(db, 'rules', 'pointRules')),
        ]);
        if (cancelled) return;
        const nonAdmin = (usersSnap?.docs || []).filter(d => {
          const u = d.data();
          return !u.isAdmin && u.isAdmin !== 'true';
        });
        setParticipatingUserCount(nonAdmin.length);
        setParticipatingUsersForScoring(nonAdmin.map(d => ({ id: d.id, ...d.data() })));
        if (ptSnap?.exists()) {
          setPointRules(ptSnap.data());
        }
        const byMatchCrowd = {};
        allPredSnap.docs.forEach(d => {
          const data = d.data();
          const mid = data.matchId ?? data.matchID;
          if (mid == null) return;
          const key = String(mid);
          if (!byMatchCrowd[key]) byMatchCrowd[key] = [];
          byMatchCrowd[key].push({
            userId: data.userId,
            predictedWinner: data.predictedWinner,
          });
        });
        setCrowdPredictionsByMatch(byMatchCrowd);
      } catch {
        if (!cancelled) {
          setCrowdPredictionsByMatch({});
          setParticipatingUserCount(null);
          setParticipatingUsersForScoring(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [user, activeSection, matchesRefresh]);

  useEffect(() => {
    const fetchLeaderboard = async () => {
      if (activeSection !== 'leaderboard' && activeSection !== 'dashboard') return;
      setLeaderboardLoading(true);
      try {
        const [usersSnap, matchesSnap, predsSnap, ptSnap, progSnap, qSnap, aSnap, ciSnap] = await Promise.all([
          getDocs(collection(db, 'users')).catch(() => ({ docs: [] })),
          getDocs(collection(db, 'matches')),
          getDocs(collection(db, 'predictions')),
          getDoc(doc(db, 'rules', 'pointRules')),
          getDoc(doc(db, 'settings', 'programConfig')).catch(() => null),
          getDocs(query(collection(db, 'cricket_questions'), where('approved', '==', true))).catch(() => ({
            docs: [],
          })),
          getDocs(collection(db, 'cricket_answers')).catch(() => ({ docs: [] })),
          getDoc(doc(db, 'settings', 'cricketInsights')).catch(() => null),
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
        let insightRecalc = null;
        try {
          const { questionsByMatchId, answersByUserId } = buildInsightRecalcFromSnapshots(
            qSnap.docs,
            aSnap.docs
          );
          const ciData = ciSnap?.exists() ? ciSnap.data() : {};
          const cricketInsightsConfig = {
            insightWrongAnswerPenalty:
              ciData.insightWrongAnswerPenalty != null && ciData.insightWrongAnswerPenalty !== ''
                ? Number(ciData.insightWrongAnswerPenalty)
                : undefined,
          };
          const penalty = getInsightWrongAnswerPenalty({ cricketInsightsConfig, pointRules: rules });
          insightRecalc = { questionsByMatchId, answersByUserId, penalty };
        } catch (e) {
          console.error('Insight leaderboard recalc:', e);
        }
        setPointRules(rules);
        setLeaderboardRawData({ users, allMatches, predsByMatch, rules, programConfig, insightRecalc });
      } catch (err) {
        console.error('Leaderboard fetch error:', err);
      }
      setLeaderboardLoading(false);
    };
    fetchLeaderboard();
  }, [user, activeSection, leaderboardRefresh]);

  useEffect(() => {
    if (!user?.uid || activeSection !== 'dashboard') return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(collection(db, 'prediction_contexts'));
        const activeIds = snap.docs
          .filter((d) => d.data().active === true)
          .map((d) => d.id);
        const results = await Promise.all(
          activeIds.map((id) => getDoc(doc(db, 'prediction_contexts', id, 'responses', user.uid)))
        );
        const n = results.filter((rs) => {
          if (!rs.exists()) return false;
          const ids = rs.data().selectedTeamIds;
          return Array.isArray(ids) && ids.length > 0;
        }).length;
        if (!cancelled) setChallengeParticipatedCount(n);
      } catch (e) {
        console.error(e);
        if (!cancelled) setChallengeParticipatedCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.uid, activeSection, leaderboardRefresh]);

  useEffect(() => {
    if (!leaderboardRawData) return;
    const { users, allMatches, predsByMatch, rules, programConfig, insightRecalc } = leaderboardRawData;
    const matchStartDate = (programConfig?.matchStartDate || '').trim();
    const prevCtx = getPreviousRankContext(allMatches, leaderboardDate || '');

    let rankedAtPrevious = [];
    if (prevCtx.excludeLastCompletedMatch) {
      rankedAtPrevious = computeRankedMainLeaderboard(
        allMatches,
        users,
        predsByMatch,
        rules,
        matchStartDate,
        null,
        prevCtx.completedSubset
      );
    } else if (prevCtx.cutoffLabel) {
      rankedAtPrevious = computeRankedMainLeaderboard(
        allMatches,
        users,
        predsByMatch,
        rules,
        matchStartDate,
        prevCtx.cutoffLabel
      );
    }
    const rankAtPreviousById = new Map(rankedAtPrevious.map((u) => [u.id, u.rank]));

    const ranked = computeRankedMainLeaderboard(
      allMatches,
      users,
      predsByMatch,
      rules,
      matchStartDate,
      leaderboardDate || ''
    );
    const hasPreviousRank = prevCtx.cutoffLabel || prevCtx.excludeLastCompletedMatch;
    setLeaderboard(
      ranked.map((u) => ({
        ...u,
        rankAtPrevious: hasPreviousRank ? rankAtPreviousById.get(u.id) ?? null : null,
      }))
    );

    let insightAtPrevious = [];
    if (prevCtx.excludeLastCompletedMatch) {
      insightAtPrevious = computeInsightRankedFromMatches(users, prevCtx.completedSubset, insightRecalc);
    } else if (prevCtx.cutoffLabel) {
      insightAtPrevious = computeInsightRanked(users, allMatches, prevCtx.cutoffLabel, insightRecalc);
    }
    const insightRankAtPreviousById = new Map(insightAtPrevious.map((u) => [u.id, u.rank]));
    const insightRanked = computeInsightRanked(users, allMatches, leaderboardDate || '', insightRecalc);
    setInsightLeaderboard(
      insightRanked.map((u) => ({
        ...u,
        rankAtPrevious: hasPreviousRank ? insightRankAtPreviousById.get(u.id) ?? null : null,
      }))
    );

    const pickRanked = computeMatchPickStatsRanked(users, allMatches, predsByMatch, leaderboardDate || '');
    setPickStatsLeaderboard(pickRanked);
  }, [leaderboardRawData, leaderboardDate]);

  const previousRankContext = leaderboardRawData
    ? getPreviousRankContext(leaderboardRawData.allMatches, leaderboardDate || '')
    : null;
  const previousMatchCutoffDate = previousRankContext?.cutoffLabel ?? '';
  const previousColumnTitle =
    previousMatchCutoffDate
      ? previousRankContext?.excludeLastCompletedMatch
        ? `Rank through ${previousMatchCutoffDate} (excludes the latest completed match while today is selected and not yet completed)`
        : `Rank using points through ${previousMatchCutoffDate} (last match before your selected date)`
      : previousRankContext?.excludeLastCompletedMatch
        ? 'Need at least two completed matches to show a standing before the latest result'
        : 'No completed match before the selected cutoff';
  const insightPreviousColumnTitle =
    previousMatchCutoffDate
      ? previousRankContext?.excludeLastCompletedMatch
        ? `Insight rank through ${previousMatchCutoffDate} (excludes the latest completed match while today is selected and not yet completed)`
        : `Insight rank using points through ${previousMatchCutoffDate} (last match before your selected date)`
      : previousRankContext?.excludeLastCompletedMatch
        ? 'Need at least two completed matches to show a standing before the latest result'
        : 'No completed match before the selected cutoff';

  const completedMatchesForLeaderboardCount = leaderboardRawData
    ? (() => {
        let m = leaderboardRawData.allMatches.filter(isMatchCompletedWithResult);
        const d = (leaderboardDate || '').trim();
        if (d) m = m.filter((x) => (x.date || '') <= d);
        return m.length;
      })()
    : 0;

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
    setCpLoading(true);
    try {
      await changePassword(cpNewPassword);
      setCpMessage('Password changed successfully.');
      setCpNewPassword('');
      setCpConfirmPassword('');
      setTimeout(() => {
        setShowChangePasswordModal(false);
        setCpMessage('');
      }, 1500);
    } catch (err) {
      const code = err?.code || '';
      if (code === 'auth/requires-recent-login') {
        setCpMessage('For security, sign out and sign in again, then set your new password.');
      } else {
        setCpMessage(err?.message?.includes('limit') ? err.message : (err?.message || 'Could not update password.'));
      }
    }
    setCpLoading(false);
  };

  const handleUpdateUsername = async (e) => {
    e.preventDefault();
    setUsernameMessage('');
    setUsernameSaving(true);
    try {
      await updateUsername(usernameInput);
      setUsernameMessage('Username updated successfully.');
    } catch (err) {
      setUsernameMessage(err?.message || 'Failed to update username');
    }
    setUsernameSaving(false);
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
    if (!user?.uid) {
      alert('You must be signed in to save a prediction.');
      return;
    }
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
      const predRef = doc(db, 'predictions', `${user.uid}_${matchId}`);
      const existing = await getDoc(predRef);
      const now = new Date().toISOString();
      const prevData = existing.exists() ? existing.data() : null;
      const { predictionChangeLog } = resolvePredictionChangeLogForPersist(
        prevData,
        existing.exists(),
        predictedWinner,
        now
      );

      await setDoc(
        predRef,
        {
          userId: user.uid,
          matchId,
          predictedWinner,
          username: userProfile?.username,
          updatedAt: now,
          ...(!existing.exists() ? { createdAt: now } : {}),
          ...(predictionChangeLog != null ? { predictionChangeLog } : {}),
        },
        { merge: true }
      );
      const key = String(matchId);
      setPredictions(prev => ({ ...prev, [key]: predictedWinner }));
      setSavedPredictions(prev => ({ ...prev, [key]: predictedWinner }));
      setSavedMatchIds(prev => new Set([...prev, key]));
      setCrowdPredictionsByMatch(prev => {
        const list = [...(prev[key] || [])];
        const idx = list.findIndex(p => p.userId === user.uid);
        const row = { userId: user.uid, predictedWinner };
        if (idx >= 0) list[idx] = row;
        else list.push(row);
        return { ...prev, [key]: list };
      });
    } catch (err) {
      alert(err.message);
    }
    setSaving(null);
  };

  const renderCrowdMatchStats = (match) => {
    const predsForMatch = crowdPredictionsByMatch[String(match.id)] || [];
    const stats = getCrowdPredictionStats(match, predsForMatch, participatingUserCount);
    if (!stats) {
      return (
        <div className="match-crowd-predictions">
          <p className="match-crowd-predictions-title">Crowd prediction</p>
          <p className="muted crowd-no-preds">No predictions yet.</p>
        </div>
      );
    }
    const code1 = getTeamCode(match.team1, teams);
    const code2 = getTeamCode(match.team2, teams);
    const noPred = stats.noPredictionCount ?? 0;
    const canShowExpectedPts =
      Array.isArray(participatingUsersForScoring) && participatingUsersForScoring.length > 0;
    const expIfTeam1Wins = canShowExpectedPts
      ? expectedPointsIfWinner(match, participatingUsersForScoring, predsForMatch, pointRules, match.team1)
      : null;
    const expIfTeam2Wins = canShowExpectedPts
      ? expectedPointsIfWinner(match, participatingUsersForScoring, predsForMatch, pointRules, match.team2)
      : null;
    const fmtExp = (v) => (v != null ? ` (+${v})` : '');
    const aria = [
      `${code1} ${stats.team1Pct}%${fmtExp(expIfTeam1Wins)} (${stats.c1})`,
      `${code2} ${stats.team2Pct}%${fmtExp(expIfTeam2Wins)} (${stats.c2})`,
      stats.other > 0 ? `other ${stats.otherPct}% (${stats.other})` : null,
      noPred > 0 ? `no prediction ${stats.noPredictionPct}% (${noPred})` : null,
    ].filter(Boolean).join(', ');
    return (
      <div className="match-crowd-predictions">
        <p className="match-crowd-predictions-title">Crowd prediction</p>
        {stats.eligibleTotal != null && (
          <p className="muted crowd-pct-note">Percentages are of {stats.eligibleTotal} participating users (non-admin).</p>
        )}
        <div className="prediction-split-bar" role="img" aria-label={aria}>
          {stats.c1 > 0 && <span className="prediction-split-seg prediction-split-team1" style={{ flex: stats.c1 }} />}
          {stats.c2 > 0 && <span className="prediction-split-seg prediction-split-team2" style={{ flex: stats.c2 }} />}
          {stats.other > 0 && <span className="prediction-split-seg prediction-split-other" style={{ flex: stats.other }} />}
          {noPred > 0 && <span className="prediction-split-seg prediction-split-no-pred" style={{ flex: noPred }} />}
        </div>
        <div className="prediction-split-legend">
          <span>
            <span className="legend-dot legend-dot-t1" aria-hidden /> {code1}{' '}
            <strong>{stats.team1Pct}%</strong>
            {expIfTeam1Wins != null && (
              <span
                className="crowd-expected-pts"
                title="Points each correct predictor gets if this team wins (from current picks and scoring rules)"
              >
                {' '}
                (+{expIfTeam1Wins})
              </span>
            )}{' '}
            <span className="muted">({stats.c1})</span>
          </span>
          <span>
            <span className="legend-dot legend-dot-t2" aria-hidden /> {code2}{' '}
            <strong>{stats.team2Pct}%</strong>
            {expIfTeam2Wins != null && (
              <span
                className="crowd-expected-pts"
                title="Points each correct predictor gets if this team wins (from current picks and scoring rules)"
              >
                {' '}
                (+{expIfTeam2Wins})
              </span>
            )}{' '}
            <span className="muted">({stats.c2})</span>
          </span>
          {stats.other > 0 && <span className="muted">Other {stats.otherPct}% ({stats.other})</span>}
          {noPred > 0 && (
            <span className="muted">
              <span className="legend-dot legend-dot-none" aria-hidden /> No prediction <strong>{stats.noPredictionPct}%</strong> ({noPred})
            </span>
          )}
        </div>
      </div>
    );
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
        predMap.set(userId, {
          predictedWinner: data.predictedWinner,
          predictedAtIso: getPredictionSavedIso(data),
        });
      });
      const allUsersList = (usersSnap?.docs || []).filter(d => {
        const u = d.data();
        return !u.isAdmin && u.isAdmin !== 'true';
      });
      const participants = allUsersList.map(d => {
        const userId = d.id;
        const u = d.data();
        const displayName = u?.username ? toInitCap(String(u.username).replace(/_/g, ' ')) : (u?.email || userId || '—');
        const pred = predMap.get(userId);
        const predictedWinner = pred?.predictedWinner ?? null;
        const predictedAtIso = pred?.predictedAtIso ?? null;
        return { userId, predictedWinner, predictedAtIso, displayName };
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
          <div className="dashboard-header-text">
            <h1>🏏 IPL Prediction Portal</h1>
            <p className="dashboard-header-tagline">Your season hub — predictions, stats, and matches in one place</p>
          </div>
        </header>

        <div className="dashboard-content">
        {activeSection === 'dashboard' && (
          <section className="rules-section">
            <h2 className="section-heading">Overview</h2>
            {(() => {
              const completedMatches = allMatches.filter(isMatchCompletedWithResult);
              /* Only matches with prediction saved to Firestore (not unsaved dropdown selection) */
              const participatedMatches = allMatches.filter(m => savedMatchIds.has(String(m.id)));
              const completedParticipated = completedMatches.filter(m => savedMatchIds.has(String(m.id)));
              const completedParticipatedTeam = completedMatches.filter(
                (m) => savedMatchIds.has(String(m.id)) && hasTeamWinnerForScoring(m)
              );
              const wins = completedParticipatedTeam.filter(m => {
                const pred = savedPredictions[String(m.id)] ?? savedPredictions[m.id] ?? '';
                return (pred || '').toString().toLowerCase().trim() === (m.winner || '').toLowerCase().trim();
              }).length;
              const losses = completedParticipatedTeam.length - wins;
              const drawCancelledParticipated = completedMatches.filter(
                (m) => savedMatchIds.has(String(m.id)) && !hasTeamWinnerForScoring(m)
              ).length;
              const nonPrediction = completedMatches.length - completedParticipated.length;
              const totalPoints = leaderboard.find(u => u.id === user?.uid)?.points ??
                completedMatches.reduce((sum, m) => sum + (m.pointResults?.[user?.uid] ?? 0), 0);
              const insightPointsTotal = to2Decimals(insightLeaderboard.find(u => u.id === user?.uid)?.insightPoints ?? 0);
              const currentUserEntry = leaderboard.find(u => u.id === user?.uid);
              const leaderboardRank = currentUserEntry?.rank ?? '—';
              const meLbUserOverview = leaderboardRawData?.users?.find((x) => x.id === user?.uid);
              const seasonLbMap = meLbUserOverview?.seasonContestLeaderboard;
              const scoredChallengeCount =
                seasonLbMap && typeof seasonLbMap === 'object'
                  ? Object.keys(seasonLbMap).length
                  : 0;
              const joinedChallengeCount =
                typeof challengeParticipatedCount === 'number' ? challengeParticipatedCount : null;
              const seasonChallengePointsTotal = sumSeasonContestLeaderboardPoints(meLbUserOverview || {});
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
                  className="stat-card stat-card-clickable stat-card--predicted"
                  onClick={() => setShowParticipatedModal(true)}
                  title="View every match where you saved a prediction"
                >
                  <span className="stat-value">{participatedMatches?.length ?? 0}</span>
                  <span className="stat-label">Matches predicted</span>
                </button>
                <button
                  type="button"
                  className="stat-card stat-card-clickable stat-card--win-loss"
                  onClick={() => setShowWinsLossesModal(true)}
                  title="Wins and losses when a team won; draw/cancelled when you predicted but there was no team winner; missed = finished matches with no saved prediction"
                >
                  <span className="stat-value stat-value--compact">
                    {wins} / {losses} / {drawCancelledParticipated} / {nonPrediction}
                  </span>
                  <span className="stat-label">Win / loss / draw·cancel / missed</span>
                </button>
                <button
                  type="button"
                  className="stat-card stat-card-clickable"
                  onClick={() => setShowPointsHistoryModal(true)}
                  title="Match prediction points plus season-challenge points from scored picks (same total as main leaderboard)"
                >
                  <span className={`stat-value ${totalPoints >= 0 ? 'points-positive' : 'points-negative'}`}>{totalPoints}</span>
                  <span className="stat-label">Total points</span>
                </button>
                <button
                  type="button"
                  className="stat-card stat-card-clickable"
                  onClick={() => setShowChallengePointsModal(true)}
                  title={
                    leaderboardLoading
                      ? 'Loading challenge summary'
                      : `Joined ${joinedChallengeCount ?? '…'} active challenge(s); ${scoredChallengeCount} scored by admin. Points total: ${seasonChallengePointsTotal} (included in total points above).`
                  }
                >
                  <span className="stat-value stat-value--stacked">
                    <span
                      className={`stat-value-challenge-pts ${
                        seasonChallengePointsTotal >= 0 ? 'points-positive' : 'points-negative'
                      }`}
                    >
                      {leaderboardLoading ? '…' : seasonChallengePointsTotal}
                    </span>
                    {!leaderboardLoading && (
                      <span className="stat-value-challenge-count">
                        {joinedChallengeCount === null
                          ? '…'
                          : `${joinedChallengeCount} joined`}
                        {' · '}
                        {scoredChallengeCount} scored
                      </span>
                    )}
                  </span>
                  <span className="stat-label">Challenge points</span>
                </button>
                {cricketInsightsConfig.enabled && (
                  <button
                    type="button"
                    className="stat-card stat-card-clickable"
                    onClick={() => setShowInsightHistoryModal(true)}
                    title="View your Cricket Insights history (questions, attempts, points per match)"
                  >
                    <span className={`stat-value ${insightPointsTotal > 0 ? 'points-positive' : ''}`}>{insightPointsTotal}</span>
                    <span className="stat-label">Insight points</span>
                  </button>
                )}
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
                  {(leaderboardLoading && activeSection === 'dashboard') && (
                    <p className="dashboard-loading-hint muted">Loading your stats…</p>
                  )}
                  <p className="dashboard-help-hint muted">
                    Open the sidebar to jump to <strong>Teams</strong>, <strong>Rules</strong>, <strong>Matches</strong>, <strong>Season predictions</strong>, or your <strong>Account</strong>.
                  </p>
                </div>
              );
            })()}
          </section>
        )}

        {activeSection === 'teams' && (
          <section className="rules-section">
            <h2 className="section-heading">Teams</h2>
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
            <h2 className="section-heading">Rules</h2>
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

        {activeSection === 'qualifierPicks' && (
          <PredictionContextsUserPanel user={user} teams={teams} />
        )}

        {activeSection === 'leaderboard' && (
          <section className="rules-section leaderboard-section" aria-labelledby="leaderboard-section-title">
            <header className="leaderboard-page-header">
              <div className="leaderboard-page-header-text">
                <h2 id="leaderboard-section-title" className="leaderboard-page-title">
                  <span className="leaderboard-page-title-icon" aria-hidden>🏆</span>
                  Leaderboard
                </h2>
                <p className="leaderboard-page-subtitle">
                  {leaderboardTab === 'main'
                    ? 'Match prediction points plus season-challenge points (after an admin scores those challenges). The date filter applies to match points only; challenge points always count toward your total.'
                    : leaderboardTab === 'pickStats'
                      ? 'Who picked the match winner most often — counts correct / wrong / missed picks and draw or cancelled games (no points). Uses the same completed-match date filter as match points.'
                      : 'Standings from Cricket Insights quiz points. The same date filter applies as on Match points.'}
                </p>
              </div>
              {!leaderboardLoading && (
                <span className="leaderboard-player-count" aria-live="polite">
                  {leaderboardTab === 'main'
                    ? leaderboard.length
                    : leaderboardTab === 'pickStats'
                      ? pickStatsLeaderboard.length
                      : insightLeaderboard.length}{' '}
                  players
                </span>
              )}
            </header>
            <div className="leaderboard-filters">
              <div className="leaderboard-tab-row">
                <button
                  type="button"
                  className={`filter-tag ${leaderboardTab === 'main' ? 'active' : ''}`}
                  onClick={() => setLeaderboardTab('main')}
                >
                  Match points
                </button>
                <button
                  type="button"
                  className={`filter-tag ${leaderboardTab === 'pickStats' ? 'active' : ''}`}
                  onClick={() => setLeaderboardTab('pickStats')}
                >
                  Match picks
                </button>
                <button
                  type="button"
                  className={`filter-tag ${leaderboardTab === 'insights' ? 'active' : ''}`}
                  onClick={() => setLeaderboardTab('insights')}
                >
                  Insight points
                </button>
                {leaderboardTab !== 'pickStats' && (
                  <button
                    type="button"
                    className={`filter-tag ${showWinnerLoser ? 'active' : ''}`}
                    onClick={() => setShowWinnerLoser(v => !v)}
                    title={`Highlights top ${100 - (leaderboardRawData?.programConfig?.loserPercent ?? 25)}% (🏆) and bottom ${leaderboardRawData?.programConfig?.loserPercent ?? 25}% (📉) of the list`}
                  >
                    {showWinnerLoser ? 'Top / bottom: on' : 'Show top & bottom'}
                  </button>
                )}
              </div>
              <div className="leaderboard-date-group">
                <label htmlFor="leaderboard-date">Rank using matches on or before</label>
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
                    title="Use the full season (all dates)"
                  >
                    Full season
                  </button>
                </div>
                <div className="leaderboard-help-box">
                  <p className="leaderboard-help-box-text">
                    {leaderboardTab === 'pickStats' ? (
                      <>
                        <strong>Match picks</strong> use completed matches on or before{' '}
                        {leaderboardDate ? <strong>{leaderboardDate}</strong> : <strong>the full schedule</strong>}.
                        Rows are ranked by <strong>correct</strong> winner picks only (not points).{' '}
                        <strong>Draw</strong> counts games with no team winner (draw or cancelled).{' '}
                        <strong>Not predicted</strong> is when you did not submit a pick for that match.
                      </>
                    ) : (
                      <>
                        <strong>Current rank</strong> uses points from completed matches on or before{' '}
                        {leaderboardDate ? <strong>{leaderboardDate}</strong> : <strong>the full schedule</strong>}.
                        {previousMatchCutoffDate ? (
                          <>
                            {' '}
                            <strong>Previous rank</strong> is based on matches on or before{' '}
                            <strong>{previousMatchCutoffDate}</strong>
                            {previousRankContext?.excludeLastCompletedMatch ? (
                              <> (the latest finished match is ignored when today’s match is not done yet).</>
                            ) : (
                              <> — the last completed match before your selected window.</>
                            )}
                          </>
                        ) : previousRankContext?.excludeLastCompletedMatch ? (
                          <>
                            {' '}
                            <strong>Previous rank</strong> is not shown yet — we need at least two finished matches to compare.
                          </>
                        ) : (
                          <>
                            {' '}
                            <strong>Previous rank</strong> is not available for this date (no earlier completed match to compare).
                          </>
                        )}
                      </>
                    )}
                  </p>
                </div>
              </div>
            </div>
            {leaderboardTab === 'main' && (
              <>
                <p className="leaderboard-points-rules muted">
                  Matches: no prediction −{pointRules.notParticipatedPoints ?? 7} · wrong pick −{pointRules.wrongPredictionPoints ?? 5} · correct pick shares the pool. Season challenges: points from your correct picks when the admin scores the challenge.
                </p>
                {leaderboardLoading ? (
                  <p className="leaderboard-loading-hint muted">Loading rankings…</p>
                ) : leaderboard.length === 0 ? (
                  <div className="leaderboard-empty">
                    <p className="leaderboard-empty-title">No standings yet</p>
                    <p className="muted">
                      Rankings use match points once there is at least one completed match with calculated points. Season-challenge
                      points count too once an admin has scored those challenges, even if you have no match rows yet.
                    </p>
                  </div>
                ) : (
                  <>
                    {user && (() => {
                      const myEntry = leaderboard.find(u => u.id === user.uid);
                      const myRank = myEntry?.rank ?? 0;
                      const myPrevRank = myEntry?.rankAtPrevious ?? 0;
                      const myPoints = myEntry?.points ?? 0;
                      return (
                        <div className="leaderboard-toolbar">
                          <p className="leaderboard-summary">
                            <span className="leaderboard-summary-item">
                              Your rank: <strong>{myRank > 0 ? `#${myRank}` : '—'}</strong>
                            </span>
                            {previousMatchCutoffDate && (
                              <span className="leaderboard-summary-item">
                                Previous: <strong>{myPrevRank > 0 ? `#${myPrevRank}` : '—'}</strong>
                              </span>
                            )}
                            <span className="leaderboard-summary-item">
                              Match points: <strong className={myPoints >= 0 ? 'points-positive' : 'points-negative'}>{myPoints}</strong>
                            </span>
                          </p>
                          <button
                            type="button"
                            className="btn btn-sm leaderboard-refresh-btn"
                            onClick={() => setLeaderboardRefresh(r => r + 1)}
                            title="Reload rankings from the server"
                          >
                            Refresh
                          </button>
                        </div>
                      );
                    })()}
                    {!user && (
                      <div className="leaderboard-toolbar leaderboard-toolbar--solo">
                        <button
                          type="button"
                          className="btn btn-sm leaderboard-refresh-btn"
                          onClick={() => setLeaderboardRefresh(r => r + 1)}
                          title="Reload rankings from the server"
                        >
                          Refresh
                        </button>
                      </div>
                    )}
                    <div className={`leaderboard-table ${showWinnerLoser ? 'leaderboard-with-wl' : ''}`}>
                      <div className="leaderboard-header">
                        <span className="leaderboard-th-rank" title="Rank for points up to the selected date">
                          Rank
                        </span>
                        <span
                          className="leaderboard-th-rank leaderboard-th-prev"
                          title={previousColumnTitle}
                        >
                          <span className="leaderboard-th-long">Previous</span>
                          <span className="leaderboard-th-short" aria-hidden="true">Prev.</span>
                        </span>
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
                              <span className="leaderboard-rank-last" title={previousColumnTitle}>
                                {u.rankAtPrevious != null && u.rankAtPrevious > 0 ? `#${u.rankAtPrevious}` : '—'}
                              </span>
                              <button
                                type="button"
                                className="leaderboard-username-btn"
                                onClick={() => setUserPointHistoryModal({ user: u, mode: 'match' })}
                                title="View leaderboard history: match points (for selected date) and season challenge points"
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
            {leaderboardTab === 'pickStats' && (
              <>
                <p className="leaderboard-points-rules muted">
                  Sorted by most correct match-winner picks. Draw or cancelled games are counted in <strong>Draw</strong> only (no correct/wrong).
                </p>
                {leaderboardLoading ? (
                  <p className="leaderboard-loading-hint muted">Loading pick stats…</p>
                ) : completedMatchesForLeaderboardCount === 0 ? (
                  <div className="leaderboard-empty">
                    <p className="leaderboard-empty-title">No finished matches in this range</p>
                    <p className="muted">
                      Pick stats appear once there is at least one completed match on or before your selected date (or use Full season).
                    </p>
                  </div>
                ) : pickStatsLeaderboard.length === 0 ? (
                  <div className="leaderboard-empty">
                    <p className="leaderboard-empty-title">No players</p>
                    <p className="muted">There are no eligible players to show.</p>
                  </div>
                ) : (
                  <>
                    {user && (() => {
                      const myEntry = pickStatsLeaderboard.find(u => u.id === user.uid);
                      const myRank = myEntry?.rank ?? 0;
                      const myCorrect = myEntry?.pickCorrect ?? 0;
                      return (
                        <div className="leaderboard-toolbar">
                          <p className="leaderboard-summary">
                            <span className="leaderboard-summary-item">
                              Your rank: <strong>{myRank > 0 ? `#${myRank}` : '—'}</strong>
                            </span>
                            <span className="leaderboard-summary-item">
                              Correct picks: <strong className="points-positive">{myCorrect}</strong>
                            </span>
                          </p>
                          <button
                            type="button"
                            className="btn btn-sm leaderboard-refresh-btn"
                            onClick={() => setLeaderboardRefresh(r => r + 1)}
                            title="Reload data from the server"
                          >
                            Refresh
                          </button>
                        </div>
                      );
                    })()}
                    {!user && (
                      <div className="leaderboard-toolbar leaderboard-toolbar--solo">
                        <button
                          type="button"
                          className="btn btn-sm leaderboard-refresh-btn"
                          onClick={() => setLeaderboardRefresh(r => r + 1)}
                          title="Reload data from the server"
                        >
                          Refresh
                        </button>
                      </div>
                    )}
                    <div className="leaderboard-table leaderboard-pick-grid">
                      <div className="leaderboard-header">
                        <span className="leaderboard-th-rank" title="Rank by number of correct winner picks">
                          Rank
                        </span>
                        <span>Name</span>
                        <span title="Picked the winning team">Correct</span>
                        <span title="Picked the losing team">Wrong</span>
                        <span title="No prediction saved for that match">Not predicted</span>
                        <span title="Match ended in draw or was cancelled (no team winner)">Draw</span>
                      </div>
                      {pickStatsLeaderboard.map((u) => (
                        <div key={u.id} className={`leaderboard-row ${u.id === user?.uid ? 'current-user' : ''}`}>
                          <span>#{u.rank}</span>
                          <span className="leaderboard-name-cell">
                            {toInitCap(u.username || u.email || 'User')}
                          </span>
                          <span className="points-positive">{u.pickCorrect ?? 0}</span>
                          <span className="points-negative">{u.pickWrong ?? 0}</span>
                          <span>{u.pickNotPredicted ?? 0}</span>
                          <span>{u.pickDraw ?? 0}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            {leaderboardTab === 'insights' && (
              <>
                <p className="leaderboard-insight-intro muted">
                  Points from Cricket Insights — correct answers on match-day questions. Same date filter applies as for match points.
                </p>
                {leaderboardLoading ? (
                  <p className="leaderboard-loading-hint muted">Loading insight rankings…</p>
                ) : insightLeaderboard.length === 0 ? (
                  <div className="leaderboard-empty">
                    <p className="leaderboard-empty-title">No insight points yet</p>
                    <p className="muted">Answer Cricket Insights questions on match cards to earn points and show up here.</p>
                  </div>
                ) : (
                  <>
                    {user && (() => {
                      const myEntry = insightLeaderboard.find(u => u.id === user.uid);
                      const myRank = myEntry?.rank ?? 0;
                      const myPrevRank = myEntry?.rankAtPrevious ?? 0;
                      const myInsightPoints = myEntry?.insightPoints ?? 0;
                      return (
                        <div className="leaderboard-toolbar">
                          <p className="leaderboard-summary">
                            <span className="leaderboard-summary-item">
                              Your rank: <strong>{myRank > 0 ? `#${myRank}` : '—'}</strong>
                            </span>
                            {previousMatchCutoffDate && (
                              <span className="leaderboard-summary-item">
                                Previous: <strong>{myPrevRank > 0 ? `#${myPrevRank}` : '—'}</strong>
                              </span>
                            )}
                            <span className="leaderboard-summary-item">
                              Insight points: <strong className="points-positive">{myInsightPoints}</strong>
                            </span>
                          </p>
                          <button
                            type="button"
                            className="btn btn-sm leaderboard-refresh-btn"
                            onClick={() => setLeaderboardRefresh(r => r + 1)}
                            title="Reload rankings from the server"
                          >
                            Refresh
                          </button>
                        </div>
                      );
                    })()}
                    {!user && (
                      <div className="leaderboard-toolbar leaderboard-toolbar--solo">
                        <button
                          type="button"
                          className="btn btn-sm leaderboard-refresh-btn"
                          onClick={() => setLeaderboardRefresh(r => r + 1)}
                          title="Reload rankings from the server"
                        >
                          Refresh
                        </button>
                      </div>
                    )}
                    <div className={`leaderboard-table ${showWinnerLoser ? 'leaderboard-with-wl' : ''}`}>
                      <div className="leaderboard-header">
                        <span className="leaderboard-th-rank" title="Rank for insight points up to the selected date">
                          Rank
                        </span>
                        <span
                          className="leaderboard-th-rank leaderboard-th-prev"
                          title={insightPreviousColumnTitle}
                        >
                          <span className="leaderboard-th-long">Previous</span>
                          <span className="leaderboard-th-short" aria-hidden="true">Prev.</span>
                        </span>
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
                              <span className="leaderboard-rank-last" title={insightPreviousColumnTitle}>
                                {u.rankAtPrevious != null && u.rankAtPrevious > 0 ? `#${u.rankAtPrevious}` : '—'}
                              </span>
                              <button
                                type="button"
                                className="leaderboard-username-btn"
                                onClick={() => setUserPointHistoryModal({ user: u, mode: 'insight' })}
                                title="View insight point history"
                              >
                                {toInitCap(u.username || u.email || 'User')}
                              </button>
                              <span className="points-positive">{u.insightPoints ?? 0}</span>
                              {showWinnerLoser && (
                                <span
                                  title={
                                    u.rank === 1
                                      ? isWinner
                                        ? `Winner (top ${100 - loserVal}%)`
                                        : `Loser (bottom ${loserVal}%)`
                                      : undefined
                                  }
                                  className="leaderboard-wl-symbol"
                                >
                                  {u.rank === 1 ? (isWinner ? '🏆' : '📉') : ''}
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

        {activeSection === 'account' && (
        <section className="rules-section account-section">
          <h2 className="section-heading">Account</h2>
          <div className="account-details">
            <h3>Your Details</h3>
            <dl className="account-details-list">
              <dt>Username</dt>
              <dd>{toInitCap(userProfile?.username || '—')}</dd>
              <dt>Email</dt>
              <dd>{user?.email || '—'}</dd>
              {userProfile?.isAdmin && (
                <>
                  <dt>Role</dt>
                  <dd>Admin</dd>
                </>
              )}
            </dl>
          </div>
          <form className="account-form account-username-form" onSubmit={handleUpdateUsername}>
            <h3>Change username</h3>
            <p className="muted">Letters, numbers, spaces, or underscores. This is used to log in and shown across the app.</p>
            {usernameMessage && (
              <div className={`alert alert-toast ${usernameMessage.includes('success') ? 'alert-success' : 'alert-error'}`}>
                {usernameMessage}
              </div>
            )}
            <div className="form-group">
              <label htmlFor="account-username">New username</label>
              <input
                id="account-username"
                type="text"
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
                placeholder="Your username"
                autoComplete="username"
                disabled={usernameSaving}
                maxLength={40}
              />
            </div>
            <div className="account-username-submit-row">
              <button type="submit" className="btn btn-primary" disabled={usernameSaving}>
                {usernameSaving ? 'Saving…' : 'Save username'}
              </button>
            </div>
          </form>
          <div className="account-actions account-actions-row" role="group" aria-label="Account actions">
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
            {!userProfile?.isAdmin && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => { setShowSurrenderModal(true); setSurrenderError(''); }}
              >
                Surrender Account
              </button>
            )}
          </div>
          {userProfile?.isAdmin && (
            <p className="muted" style={{ marginTop: '1rem' }}>Admin accounts cannot surrender. Use the Admin Panel to manage users.</p>
          )}
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
          <h2 className="section-heading">Today&rsquo;s matches ({today})</h2>
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
                <div key={match.id} id={`match-${match.id}`} className="match-card">
                  <div className="match-card-icons">
                    <button
                      type="button"
                      className="btn btn-sm btn-outline btn-icon-only"
                      onClick={() => openParticipantsModal(match)}
                      title="View participants: your pick only until cutoff (no save times); after cutoff all picks and times; points when scored"
                      aria-label="View all participants"
                    >
                      👥
                    </button>
                    {cricketInsightsConfig.enabled && (match.date || '') <= today && (
                      <button
                        type="button"
                        className={`btn btn-sm btn-insight btn-icon-only ${expandedInsightMatchId === match.id ? 'active' : ''}`}
                        onClick={() => setExpandedInsightMatchId(expandedInsightMatchId === match.id ? null : match.id)}
                        title="Ask or answer Cricket Insights questions"
                        aria-label="Cricket Insights"
                      >
                        <span className="btn-insight-count">{insightQuestionCount[String(match.id)] ?? 0}</span>
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
                    {formatMatchVenue(match) && (
                      <p className="match-venue">🏟 {formatMatchVenue(match)}</p>
                    )}
                  </div>
                  <div className="match-prediction">
                        {!canUserPredict(userProfile, programConfig) ? (
                      <>
                        <p className="prediction-closed">Awaiting admin approval. You registered after the match start date. Contact admin to get approval for predictions.</p>
                        {shouldShowCrowdPrediction(programConfig, match) && renderCrowdMatchStats(match)}
                      </>
                    ) : !isPredictionEligible(match) ? (
                      <>
                        {(match.status || '').toLowerCase() !== 'completed' && (
                          <p className="prediction-closed">Prediction closed. Cutoff was {formatMatchTime(match.thresholdTime || match.time)} on {match.date}.</p>
                        )}
                        {match.winner && (
                          <p className="match-winner-badge">
                            {isDrawOrCancelledWinner(match.winner)
                              ? `🏁 Result: ${getMatchResultLabel(match, getTeamCode, teams)}`
                              : `🏆 Winner: ${getTeamCode(match.winner, teams)}`}
                          </p>
                        )}
                        <div className="match-points-row">
                          {match.pointResults && match.pointResults[user?.uid] != null && (
                            <p className="match-points-badge">Your points: <strong className={match.pointResults[user.uid] >= 0 ? 'points-positive' : 'points-negative'}>{match.pointResults[user.uid]}</strong></p>
                          )}
                          {cricketInsightsConfig.enabled &&
                            Number(insightPointsByMatch[match.id] ?? 0) !== 0 && (
                            <p className="match-points-badge match-insight-points">
                              Insight points:{' '}
                              <strong
                                className={
                                  Number(insightPointsByMatch[match.id]) >= 0 ? 'points-positive' : 'points-negative'
                                }
                              >
                                {Number(insightPointsByMatch[match.id]) >= 0 ? '+' : ''}
                                {insightPointsByMatch[match.id]}
                              </strong>
                            </p>
                          )}
                        </div>
                        {shouldShowCrowdPrediction(programConfig, match) && renderCrowdMatchStats(match)}
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
                    {shouldShowCrowdPrediction(programConfig, match) && renderCrowdMatchStats(match)}
                    </>
                    )}
                  </div>
                  {savedMatchIds.has(String(match.id)) && (() => {
                    const savedVal = savedPredictions[String(match.id)] ?? savedPredictions[match.id];
                    return savedVal ? <p className="saved-badge">✓ Saved: {getTeamCode(savedVal, teams)}</p> : null;
                  })()}
                  {cricketInsightsConfig.enabled && expandedInsightMatchId === match.id && (
                    <div className="match-insights">
                      <CricketInsights matchId={match.id} matchDate={match.date} matchStatus={match.status} match={match} config={cricketInsightsConfig} />
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
              <h2 className="section-heading">
                Match history {matchFilterDate ? <span className="section-heading-meta">({matchFilterDate})</span> : <span className="section-heading-meta">(all dates)</span>}
              </h2>
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
                    <div key={match.id} id={`match-${match.id}`} className="match-card match-card-history">
                      <div className="match-card-icons">
                        <button
                          type="button"
                          className="btn btn-sm btn-outline btn-icon-only"
                          onClick={() => openParticipantsModal(match)}
                          title="View participants: your pick only until cutoff (no save times); after cutoff all picks and times; points when scored"
                          aria-label="View all participants"
                        >
                          👥
                        </button>
                        {cricketInsightsConfig.enabled && (match.date || '') <= today && (
                          <button
                            type="button"
                            className={`btn btn-sm btn-insight btn-icon-only ${expandedInsightMatchId === match.id ? 'active' : ''}`}
                            onClick={() => setExpandedInsightMatchId(expandedInsightMatchId === match.id ? null : match.id)}
                            title="Ask or answer Cricket Insights questions"
                            aria-label="Cricket Insights"
                          >
                            <span className="btn-insight-count">{insightQuestionCount[String(match.id)] ?? 0}</span>
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
                        {formatMatchVenue(match) && (
                          <p className="match-venue">🏟 {formatMatchVenue(match)}</p>
                        )}
                        {match.winner && (
                          <p className="match-winner-badge">
                            {isDrawOrCancelledWinner(match.winner)
                              ? `🏁 Result: ${getMatchResultLabel(match, getTeamCode, teams)}`
                              : `🏆 Winner: ${getTeamCode(match.winner, teams)}`}
                          </p>
                        )}
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
                        {cricketInsightsConfig.enabled &&
                          Number(insightPointsByMatch[match.id] ?? 0) !== 0 && (
                          <p className="match-points-badge match-insight-points">
                            Insight points:{' '}
                            <strong
                              className={
                                Number(insightPointsByMatch[match.id]) >= 0 ? 'points-positive' : 'points-negative'
                              }
                            >
                              {Number(insightPointsByMatch[match.id]) >= 0 ? '+' : ''}
                              {insightPointsByMatch[match.id]}
                            </strong>
                          </p>
                        )}
                      </div>
                      {shouldShowCrowdPrediction(programConfig, match) && renderCrowdMatchStats(match)}
                      {cricketInsightsConfig.enabled && expandedInsightMatchId === match.id && (
                        <div className="match-insights">
                          <CricketInsights matchId={match.id} matchDate={match.date} matchStatus={match.status} match={match} config={cricketInsightsConfig} />
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
                  const beforeCutoff = isPredictionEligible(m);
                  const showPredictedAt = !beforeCutoff;
                  const isCompleted = isMatchCompletedWithResult(m);
                  const pointResults = m?.pointResults && typeof m.pointResults === 'object' ? m.pointResults : null;
                  const showPoints = isCompleted && pointResults;
                  const colClass = beforeCutoff
                    ? showPoints
                      ? 'cols-dashboard-pre-cutoff-3'
                      : 'cols-2'
                    : showPoints
                      ? 'cols-4'
                      : 'cols-3';
                  return (
                    <>
                      {beforeCutoff && (
                        <p className="muted participants-points-note">
                          Before the prediction cutoff ({formatMatchTime(m?.thresholdTime || m?.time)} on {m?.date}), you only see
                          your own team pick; everyone else&apos;s stay private. Save times and everyone&apos;s picks appear after
                          cutoff; points show once the match is completed and scored.
                        </p>
                      )}
                      {!beforeCutoff && !showPoints && (
                        <p className="muted participants-points-note">
                          Team picks are visible. Points appear after the match is completed and an admin has calculated them.
                        </p>
                      )}
                      {showPoints && (
                        <p className="muted participants-points-note">Points shown for completed match with winner declared.</p>
                      )}
                      <ul className="participants-list">
                        <li className={`participants-list-header ${colClass}`}>
                          <span>User</span>
                          <span>Prediction</span>
                          {showPredictedAt && <span className="col-predicted-at">Predicted at</span>}
                          {showPoints && <span className="col-points">Points</span>}
                        </li>
                        {participantsModal.participants.map((p, i) => {
                    const pts = showPoints && p.userId ? pointResults[p.userId] : undefined;
                    const ptsNum = pts != null && !Number.isNaN(Number(pts)) ? to2Decimals(Number(pts)) : null;
                    const timeStr = formatTimeHH24(p.predictedAtIso);
                    const canSeeThisPick = !beforeCutoff || p.userId === user?.uid;
                    const pickDisplay = (() => {
                      if (!p.predictedWinner) return { text: '—', title: undefined };
                      const code = getTeamCode(p.predictedWinner, teams) || p.predictedWinner;
                      if (canSeeThisPick) return { text: code, title: undefined };
                      return { text: '—', title: 'Hidden until prediction cutoff' };
                    })();
                    return (
                      <li key={p.userId || i} className={`participant-item ${colClass}`}>
                        <span className="participant-name">{p.displayName}</span>
                        <span
                          className={`participant-prediction${!canSeeThisPick && p.predictedWinner ? ' participant-prediction--hidden' : ''}`}
                          title={pickDisplay.title}
                        >
                          {pickDisplay.text}
                        </span>
                        {showPredictedAt && (
                          <span className="participant-predicted-at" title={p.predictedAtIso || undefined}>
                            {timeStr}
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

      {showPointsHistoryModal && createPortal(
        <div className="modal-overlay" onClick={() => setShowPointsHistoryModal(false)}>
          <div className="modal-content modal-content--points-history" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header modal-header--points-history">
              <div className="modal-header-points-text">
                <h3 id="points-history-modal-title">Prediction point history</h3>
                <p className="modal-subtitle">{toInitCap(userProfile?.username || user?.email || 'You')}</p>
              </div>
              <button type="button" className="modal-close" onClick={() => setShowPointsHistoryModal(false)} aria-label="Close">&times;</button>
            </div>
            <div className="point-history-body">
            {(() => {
              const meLbUser = leaderboardRawData?.users?.find((x) => x.id === user?.uid);
              const seasonChallengeTotal = sumSeasonContestLeaderboardPoints(meLbUser || {});
              const seasonMap = meLbUser?.seasonContestLeaderboard;
              const seasonEntries =
                seasonMap && typeof seasonMap === 'object' ? Object.entries(seasonMap) : [];
              const completed = sortMatchesChronological(
                allMatches.filter(isMatchCompletedWithResult)
              );
              const rowsChrono = [];
              let runningPred = 0;
              let runningInsight = 0;
              for (const m of completed) {
                const predPoints = m.pointResults?.[user?.uid];
                const insightPts = to2Decimals(insightPointsByMatch[m.id] ?? 0);
                const predVal = predPoints != null ? Number(predPoints) : 0;
                const insVal = Number(insightPointsByMatch[m.id] ?? 0);
                runningPred = to2Decimals(runningPred + predVal);
                runningInsight = to2Decimals(runningInsight + insVal);
                const dispPred = predPoints != null ? to2Decimals(predPoints) : null;
                rowsChrono.push({ m, dispPred, insightPts, runningPred, runningInsight });
              }
              const displayRows = [...rowsChrono].reverse();
              const latest = displayRows[0];
              const matchPredTotal = latest?.runningPred ?? 0;
              const mainLeaderboardTotal = to2Decimals(matchPredTotal + seasonChallengeTotal);
              if (completed.length === 0 && seasonEntries.length === 0) {
                return (
                  <div className="point-history-empty">
                    <p className="point-history-empty-title">No points history yet</p>
                    <p className="muted">
                      Match points show after games finish and an admin calculates them. Season-challenge points appear after
                      an admin scores that challenge (from your correct picks).
                    </p>
                  </div>
                );
              }
              return (
                <div className="point-history-root">
                  <div className="point-history-summary" role="region" aria-label="Totals">
                    <div className="point-history-summary-main">
                      <span className="point-history-summary-label">Match prediction total</span>
                      <span className="point-history-summary-value">{matchPredTotal}</span>
                    </div>
                    {seasonEntries.length > 0 && (
                      <div className="point-history-summary-secondary">
                        <span className="muted">Season challenges (scored picks)</span>
                        <strong className={seasonChallengeTotal >= 0 ? 'points-positive' : 'points-negative'}>
                          {seasonChallengeTotal >= 0 ? '+' : ''}
                          {seasonChallengeTotal}
                        </strong>
                      </div>
                    )}
                    <div className="point-history-summary-main" style={{ marginTop: '0.65rem', paddingTop: '0.65rem', borderTop: '1px solid var(--border)' }}>
                      <span className="point-history-summary-label">Leaderboard total</span>
                      <span className="point-history-summary-value">{mainLeaderboardTotal}</span>
                    </div>
                    {cricketInsightsConfig.enabled && latest && (
                      <div className="point-history-summary-secondary">
                        <span className="muted">Insight points (running, not in leaderboard)</span>
                        <strong className={latest.runningInsight > 0 ? 'points-positive' : ''}>{latest.runningInsight}</strong>
                      </div>
                    )}
                  </div>
                  <SeasonChallengeLeaderboardHistoryList
                    entries={seasonEntries}
                    intro="Season challenges: points from correct picks when an admin scores each challenge (included in your leaderboard total above)."
                  />
                  {completed.length > 0 && (
                    <>
                  <p className="point-history-intro">
                    Newest matches first. Each row shows points for that match and your running match total after it.
                  </p>
                  <div className="points-history-scroll point-history-scroll">
                    <ul className="point-history-cards">
                      {displayRows.map(({ m, dispPred, insightPts, runningPred: rp, runningInsight: ri }) => (
                        <li key={m.id} className="point-history-card">
                          <div className="point-history-card-head">
                            <span className="point-history-card-badge">Match #{m.matchNumber || m.id}</span>
                            <span className="point-history-card-date">{m.date}</span>
                          </div>
                          <p className="point-history-card-teams">
                            {getTeamCode(m.team1, teams)} <span className="point-history-vs">vs</span> {getTeamCode(m.team2, teams)}
                          </p>
                          <dl className="point-history-dl">
                            <div>
                              <dt>Result</dt>
                              <dd>{getMatchResultLabel(m, getTeamCode, teams)}</dd>
                            </div>
                            <div>
                              <dt>This match</dt>
                              <dd>
                                {dispPred != null ? (
                                  <span className={dispPred >= 0 ? 'points-positive' : 'points-negative'}>
                                    {dispPred >= 0 ? '+' : ''}{dispPred}
                                  </span>
                                ) : (
                                  <span className="muted">—</span>
                                )}
                              </dd>
                            </div>
                            {cricketInsightsConfig.enabled && (
                              <div>
                                <dt>Insight (this match)</dt>
                                <dd className={insightPts > 0 ? 'points-positive' : ''}>
                                  {insightPts > 0 ? `+${insightPts}` : '0'}
                                </dd>
                              </div>
                            )}
                            <div className="point-history-dl-cumulative">
                              <dt>Running total · Pred</dt>
                              <dd>{rp}</dd>
                            </div>
                            {cricketInsightsConfig.enabled && (
                              <div className="point-history-dl-cumulative point-history-dl-insight-row">
                                <dt>Running total · Insight</dt>
                                <dd className={ri > 0 ? 'points-positive' : ''}>{ri >= 0 ? '+' : ''}{ri}</dd>
                              </div>
                            )}
                          </dl>
                        </li>
                      ))}
                    </ul>
                  </div>
                    </>
                  )}
                </div>
              );
            })()}
            </div>
          </div>
        </div>,
        document.body
      )}

      {showChallengePointsModal && user && createPortal(
        <div className="modal-overlay" onClick={() => setShowChallengePointsModal(false)}>
          <div className="modal-content modal-content--challenge-points" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header modal-header--points-history">
              <div className="modal-header-points-text">
                <h3 id="challenge-points-modal-title">Challenge points</h3>
                <p className="modal-subtitle">{toInitCap(userProfile?.username || user?.email || 'You')}</p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowChallengePointsModal(false)}
                aria-label="Close"
              >
                &times;
              </button>
            </div>
            <div className="challenge-points-modal-scroll">
              <MyChallengePointsPanel user={user} teams={teams} variant="modal" />
            </div>
          </div>
        </div>,
        document.body
      )}

      {showInsightHistoryModal && user && cricketInsightsConfig.enabled && createPortal(
        <div className="modal-overlay" onClick={() => setShowInsightHistoryModal(false)}>
          <div className="modal-content modal-content--insight" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header modal-header--insight">
              <div className="modal-header-insight-text">
                <h3 id="insight-history-modal-title">Cricket insight history</h3>
                <p className="modal-subtitle">{toInitCap(userProfile?.username || user?.email || 'You')}</p>
              </div>
              <button type="button" className="modal-close" onClick={() => setShowInsightHistoryModal(false)} aria-label="Close">&times;</button>
            </div>
            <div className="point-history-body">
              <InsightHistoryModalContent
                userId={user.uid}
                completedMatches={sortMatchesChronological(
                  allMatches.filter(isMatchCompletedWithResult)
                )}
                teams={teams}
                getTeamCode={getTeamCode}
                insightPenaltyContext={{ cricketInsightsConfig, pointRules }}
                leaderboardRefresh={leaderboardRefresh}
              />
            </div>
          </div>
        </div>,
        document.body
      )}

      {userPointHistoryModal && createPortal(
        <div className="modal-overlay" onClick={() => setUserPointHistoryModal(null)}>
          <div
            className={`modal-content ${userPointHistoryModal.mode === 'insight' ? 'modal-content--insight' : 'modal-content--points-history'}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className={`modal-header ${userPointHistoryModal.mode === 'insight' ? 'modal-header--insight' : 'modal-header--points-history'}`}
            >
              {userPointHistoryModal.mode === 'insight' ? (
                <div className="modal-header-insight-text">
                  <h3>Cricket insight history</h3>
                  <p className="modal-subtitle">
                    {toInitCap(userPointHistoryModal.user?.username || userPointHistoryModal.user?.email || 'User')}
                  </p>
                </div>
              ) : (
                <div className="modal-header-points-text">
                  <h3>Leaderboard point history</h3>
                  <p className="modal-subtitle">
                    {toInitCap(userPointHistoryModal.user?.username || userPointHistoryModal.user?.email || 'User')}
                  </p>
                </div>
              )}
              <button type="button" className="modal-close" onClick={() => setUserPointHistoryModal(null)} aria-label="Close">&times;</button>
            </div>
            {(() => {
              const historyUser = userPointHistoryModal.user;
              const historyMode = userPointHistoryModal.mode === 'insight' ? 'insight' : 'match';
              const matches = leaderboardRawData?.allMatches || [];
              const progConfig = leaderboardRawData?.programConfig || {};
              const matchStartDate = (progConfig.matchStartDate || '').trim();
              const createdAtDate = (historyUser.createdAt || '').toString().split('T')[0];
              const isLateUser =
                matchStartDate &&
                createdAtDate &&
                createdAtDate >= matchStartDate &&
                !isUserPredictionApproved(historyUser);

              if (historyMode === 'match' && isLateUser) {
                const totalPts = historyUser.points ?? 0;
                const lateSeasonEntries = Object.entries(historyUser.seasonContestLeaderboard || {});
                const lateSeasonTotal = sumSeasonContestLeaderboardPoints(historyUser);
                const lateAllocMatch = to2Decimals(totalPts - lateSeasonTotal);
                return (
                  <div className="point-history-body">
                    <div className="point-history-late-user">
                      <p className="muted">
                        This user joined on or after match start date ({matchStartDate}). Match points follow the program rule (aligned with bottom rank); season challenge points are listed separately by challenge name.
                      </p>
                      <p className="point-history-late-total">
                        <strong>Leaderboard total: {to2Decimals(totalPts)}</strong>
                      </p>
                      {lateSeasonTotal > 0 && (
                        <p className="muted" style={{ marginTop: '0.5rem' }}>
                          Of which season challenges: <strong className="points-positive">+{lateSeasonTotal}</strong> · Program
                          match allocation (remainder): <strong>{lateAllocMatch}</strong>
                        </p>
                      )}
                    </div>
                    <SeasonChallengeLeaderboardHistoryList
                      entries={lateSeasonEntries}
                      intro="Season challenges for this user (name and points)."
                    />
                  </div>
                );
              }

              let completed = sortMatchesChronological(
                matches.filter(isMatchCompletedWithResult)
              );
              if (leaderboardDate) {
                completed = completed.filter(m => (m.date || '') <= leaderboardDate);
              }
              const uid = historyUser.id;

              if (historyMode === 'insight') {
                return (
                  <div className="point-history-body">
                    <InsightHistoryModalContent
                      userId={uid}
                      completedMatches={completed}
                      teams={teams}
                      getTeamCode={getTeamCode}
                      insightPenaltyContext={{ cricketInsightsConfig, pointRules }}
                      leaderboardRefresh={leaderboardRefresh}
                    />
                  </div>
                );
              }

              const lbSeasonEntries = Object.entries(historyUser.seasonContestLeaderboard || {});
              const lbSeasonTotal = sumSeasonContestLeaderboardPoints(historyUser);
              const rowsChrono = [];
              let runningTotal = 0;
              for (const m of completed) {
                const predPoints = m.pointResults?.[uid];
                const predVal = predPoints != null ? Number(predPoints) : 0;
                runningTotal = to2Decimals(runningTotal + predVal);
                const dispPts = predPoints != null ? to2Decimals(predPoints) : null;
                rowsChrono.push({ m, dispPts, runningTotal });
              }
              const displayRows = [...rowsChrono].reverse();
              const latestLb = displayRows[0];
              const matchPredThroughCutoff = latestLb ? latestLb.runningTotal : 0;

              if (completed.length === 0 && lbSeasonEntries.length === 0) {
                return (
                  <div className="point-history-body">
                    <div className="point-history-empty">
                      <p className="point-history-empty-title">Nothing in this view</p>
                      <p className="muted">
                        No completed matches through the selected leaderboard date, and no season challenge points for this
                        user.
                      </p>
                    </div>
                  </div>
                );
              }

              return (
                <div className="point-history-body">
                  <div className="point-history-root">
                    <div className="point-history-summary" role="region" aria-label="Leaderboard totals">
                      <div className="point-history-summary-main">
                        <span className="point-history-summary-label">Match points (through cutoff)</span>
                        <span className="point-history-summary-value">{matchPredThroughCutoff}</span>
                      </div>
                      {lbSeasonEntries.length > 0 && (
                        <div className="point-history-summary-secondary">
                          <span className="muted">Season challenge points (from scoring)</span>
                          <strong className={lbSeasonTotal >= 0 ? 'points-positive' : 'points-negative'}>
                            {lbSeasonTotal >= 0 ? '+' : ''}
                            {lbSeasonTotal}
                          </strong>
                        </div>
                      )}
                      <div
                        className="point-history-summary-main"
                        style={{ marginTop: '0.65rem', paddingTop: '0.65rem', borderTop: '1px solid var(--border)' }}
                      >
                        <span className="point-history-summary-label">Leaderboard total (ranked)</span>
                        <span className="point-history-summary-value">{to2Decimals(historyUser.points ?? 0)}</span>
                      </div>
                    </div>
                    {rowsChrono.length > 0 ? (
                      <CumulativePointsLineChart
                        caption="Cumulative match prediction points (chronological)"
                        values={rowsChrono.map((r) => r.runningTotal)}
                        variant="match"
                      />
                    ) : null}
                    <SeasonChallengeLeaderboardHistoryList
                      entries={lbSeasonEntries}
                      intro="Season challenges: challenge name and points from correct picks when the admin scored each one."
                    />
                    {completed.length > 0 ? (
                      <>
                        <p className="point-history-intro">
                          Newest matches first. Running total is cumulative match prediction points after each completed match
                          (for the selected leaderboard date only).
                        </p>
                        <div className="points-history-scroll point-history-scroll">
                          <ul className="point-history-cards">
                            {displayRows.map(({ m, dispPts, runningTotal: rt }) => (
                              <li key={m.id} className="point-history-card">
                                <div className="point-history-card-head">
                                  <span className="point-history-card-badge">Match #{m.matchNumber || m.id}</span>
                                  <span className="point-history-card-date">{m.date}</span>
                                </div>
                                <p className="point-history-card-teams">
                                  {getTeamCode(m.team1, teams)} <span className="point-history-vs">vs</span>{' '}
                                  {getTeamCode(m.team2, teams)}
                                </p>
                                <dl className="point-history-dl">
                                  <div>
                                    <dt>Result</dt>
                                    <dd>{getMatchResultLabel(m, getTeamCode, teams)}</dd>
                                  </div>
                                  <div>
                                    <dt>This match</dt>
                                    <dd>
                                      {dispPts != null ? (
                                        <span className={dispPts >= 0 ? 'points-positive' : 'points-negative'}>
                                          {dispPts >= 0 ? '+' : ''}
                                          {dispPts}
                                        </span>
                                      ) : (
                                        <span className="muted">—</span>
                                      )}
                                    </dd>
                                  </div>
                                  <div className="point-history-dl-cumulative">
                                    <dt>Running total · Pred</dt>
                                    <dd>{rt}</dd>
                                  </div>
                                </dl>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>,
        document.body
      )}

      {showWinsLossesModal && createPortal(
        <div className="modal-overlay" onClick={() => setShowWinsLossesModal(false)}>
          <div className="modal-content modal-content--wins-losses" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header modal-header--wins-losses">
              <div className="modal-header-wins-losses-text">
                <h3 id="wins-losses-modal-title">Your match results</h3>
                <p className="modal-subtitle">{toInitCap(userProfile?.username || user?.email || 'You')}</p>
              </div>
              <button type="button" className="modal-close" onClick={() => setShowWinsLossesModal(false)} aria-label="Close">&times;</button>
            </div>
            <div className="wins-losses-body">
            {(() => {
              const completed = sortMatchesDescending(
                allMatches.filter(isMatchCompletedWithResult)
              );
              const participated = completed.filter(m => savedMatchIds.has(String(m.id)));
              const participatedTeam = participated.filter(hasTeamWinnerForScoring);
              const participatedDrawCancel = participated.filter((m) => !hasTeamWinnerForScoring(m));
              const noPrediction = completed.filter(m => !savedMatchIds.has(String(m.id)));
              let winCount = 0;
              let lossCount = 0;
              participatedTeam.forEach((m) => {
                const pred = (savedPredictions[String(m.id)] ?? savedPredictions[m.id] ?? '').toString().toLowerCase().trim();
                const winner = (m.winner || '').toLowerCase().trim();
                if (pred === winner) winCount++; else lossCount++;
              });
              if (participatedTeam.length === 0 && participatedDrawCancel.length === 0 && noPrediction.length === 0) {
                return (
                  <div className="wins-losses-empty">
                    <p className="wins-losses-empty-title">No completed matches yet</p>
                    <p className="muted">When matches finish, your wins, losses, and other results will show here.</p>
                  </div>
                );
              }
              return (
                <>
                  <div className="wins-losses-summary" role="region" aria-label="Results summary">
                    <ul className="wins-losses-summary-grid">
                      <li>
                        <span className="wins-losses-summary-label wins-losses-summary-label--win">Wins</span>
                        <strong className="wins-losses-summary-num wins-losses-summary-num--win">{winCount}</strong>
                      </li>
                      <li>
                        <span className="wins-losses-summary-label wins-losses-summary-label--loss">Losses</span>
                        <strong className="wins-losses-summary-num wins-losses-summary-num--loss">{lossCount}</strong>
                      </li>
                      <li>
                        <span className="wins-losses-summary-label">Draw / cancelled</span>
                        <strong className="wins-losses-summary-num">{participatedDrawCancel.length}</strong>
                      </li>
                      <li>
                        <span className="wins-losses-summary-label">No prediction</span>
                        <strong className="wins-losses-summary-num wins-losses-summary-num--muted">{noPrediction.length}</strong>
                      </li>
                    </ul>
                  </div>
                  <p className="wins-losses-intro">
                    Newest matches first. Team-based wins and losses only count when a side won; draw or cancelled matches are listed separately.
                  </p>
                  <div className="points-history-scroll wins-losses-modal-scroll">
                    {participatedTeam.length > 0 && (
                      <section className="wins-losses-section" aria-labelledby="wl-section-winloss">
                        <h4 id="wl-section-winloss" className="wins-losses-section-title">
                          Wins &amp; losses
                          <span className="wins-losses-section-count">{participatedTeam.length}</span>
                        </h4>
                        <ul className="wins-losses-cards">
                          {participatedTeam.map((m) => {
                            const pred = (savedPredictions[String(m.id)] ?? savedPredictions[m.id] ?? '').toString().toLowerCase().trim();
                            const winner = (m.winner || '').toLowerCase().trim();
                            const isWin = pred === winner;
                            return (
                              <li key={m.id} className={`wins-losses-card ${isWin ? 'wins-losses-card--win' : 'wins-losses-card--loss'}`}>
                                <div className="wins-losses-card-head">
                                  <span className={`wins-losses-card-outcome ${isWin ? 'wins-losses-card-outcome--win' : 'wins-losses-card-outcome--loss'}`}>
                                    {isWin ? 'Win' : 'Loss'}
                                  </span>
                                  <span className="wins-losses-card-date">{m.date}</span>
                                </div>
                                <p className="wins-losses-card-teams">
                                  <span className="wins-losses-card-match-no">#{m.matchNumber || m.id}</span>
                                  {' '}
                                  {getTeamCode(m.team1, teams)} <span className="wins-losses-vs">vs</span> {getTeamCode(m.team2, teams)}
                                </p>
                                <dl className="wins-losses-dl">
                                  <div>
                                    <dt>Your pick</dt>
                                    <dd>{getTeamCode(pred, teams) || pred || '—'}</dd>
                                  </div>
                                  <div>
                                    <dt>Winner</dt>
                                    <dd>{getTeamCode(m.winner, teams) || m.winner}</dd>
                                  </div>
                                </dl>
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    )}
                    {participatedDrawCancel.length > 0 && (
                      <section className="wins-losses-section" aria-labelledby="wl-section-draw">
                        <h4 id="wl-section-draw" className="wins-losses-section-title">
                          Draw / cancelled
                          <span className="wins-losses-section-count">{participatedDrawCancel.length}</span>
                        </h4>
                        <p className="wins-losses-section-hint muted">No win or loss point for these matches (prediction points are 0).</p>
                        <ul className="wins-losses-cards">
                          {participatedDrawCancel.map((m) => (
                            <li key={m.id} className="wins-losses-card wins-losses-card--neutral">
                              <div className="wins-losses-card-head">
                                <span className="wins-losses-card-outcome wins-losses-card-outcome--neutral">Draw / cancelled</span>
                                <span className="wins-losses-card-date">{m.date}</span>
                              </div>
                              <p className="wins-losses-card-teams">
                                <span className="wins-losses-card-match-no">#{m.matchNumber || m.id}</span>
                                {' '}
                                {getTeamCode(m.team1, teams)} <span className="wins-losses-vs">vs</span> {getTeamCode(m.team2, teams)}
                              </p>
                              <p className="wins-losses-card-result muted">
                                Result: <strong>{getMatchResultLabel(m, getTeamCode, teams)}</strong>
                              </p>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                    {noPrediction.length > 0 && (
                      <section className="wins-losses-section" aria-labelledby="wl-section-nopred">
                        <h4 id="wl-section-nopred" className="wins-losses-section-title">
                          No prediction
                          <span className="wins-losses-section-count">{noPrediction.length}</span>
                        </h4>
                        <ul className="wins-losses-cards">
                          {noPrediction.map((m) => (
                            <li key={m.id} className="wins-losses-card wins-losses-card--neutral">
                              <div className="wins-losses-card-head">
                                <span className="wins-losses-card-outcome wins-losses-card-outcome--skip">Skipped</span>
                                <span className="wins-losses-card-date">{m.date}</span>
                              </div>
                              <p className="wins-losses-card-teams">
                                <span className="wins-losses-card-match-no">#{m.matchNumber || m.id}</span>
                                {' '}
                                {getTeamCode(m.team1, teams)} <span className="wins-losses-vs">vs</span> {getTeamCode(m.team2, teams)}
                              </p>
                              <p className="wins-losses-card-result muted">
                                Result: <strong>{getMatchResultLabel(m, getTeamCode, teams)}</strong>
                              </p>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                  </div>
                </>
              );
            })()}
            </div>
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
                        {formatMatchVenue(m) && (
                          <span className="today-match-modal-venue">🏟 {formatMatchVenue(m)}</span>
                        )}
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
                          {m.winner && (
                            <span className="match-winner-badge">
                              {isDrawOrCancelledWinner(m.winner)
                                ? `🏁 Result: ${getMatchResultLabel(m, getTeamCode, teams)}`
                                : `🏆 Winner: ${getTeamCode(m.winner, teams)}`}
                            </span>
                          )}
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
          <div
            className="modal-content modal-content--participated"
            role="dialog"
            aria-modal="true"
            aria-labelledby="participated-matches-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header modal-header--participated">
              <div className="modal-header-participated-text">
                <h3 id="participated-matches-modal-title">Your match predictions</h3>
                <p className="modal-subtitle">{toInitCap(userProfile?.username || user?.email || 'You')}</p>
              </div>
              <button type="button" className="modal-close" onClick={() => setShowParticipatedModal(false)} aria-label="Close">&times;</button>
            </div>
            <div className="participated-matches-body">
            {(() => {
              const displayed = sortMatchesDescending(
                allMatches.filter(m => savedMatchIds.has(String(m.id)))
              );
              if (displayed.length === 0) {
                return (
                  <div className="participated-matches-empty">
                    <p className="participated-matches-empty-title">No matches yet</p>
                    <p className="muted">Save a prediction for a match and it will show up in this list.</p>
                  </div>
                );
              }
              return (
                <>
                  <div className="participated-matches-summary" role="region" aria-label="Prediction count">
                    <span className="participated-matches-summary-label">Matches with your pick</span>
                    <strong className="participated-matches-summary-num">{displayed.length}</strong>
                  </div>
                  <p className="participated-matches-intro">
                    Newest first. Your pick is shown for every match here; the final result appears once the match is complete.
                  </p>
                  <div className="points-history-scroll participated-matches-scroll">
                    <ul className="participated-matches-list">
                      {displayed.map((m) => {
                        const predicted = savedPredictions[String(m.id)] ?? savedPredictions[m.id] ?? '';
                        const isCompleted = isMatchCompletedWithResult(m);
                        return (
                          <li key={m.id} className="participated-match-card">
                            <div className="participated-match-card-head">
                              <span className="participated-match-no">#{m.matchNumber || m.id}</span>
                              <span className="participated-match-date">{m.date}</span>
                            </div>
                            <p className="participated-match-teams">
                              {getTeamCode(m.team1, teams)}{' '}
                              <span className="participated-match-vs">vs</span>{' '}
                              {getTeamCode(m.team2, teams)}
                            </p>
                            <dl className="participated-match-dl">
                              <div>
                                <dt>Your pick</dt>
                                <dd>{getTeamCode(predicted, teams) || predicted || '—'}</dd>
                              </div>
                              <div>
                                <dt>{isCompleted ? 'Result' : 'Status'}</dt>
                                <dd>
                                  {isCompleted
                                    ? getMatchResultLabel(m, getTeamCode, teams)
                                    : <span className="participated-match-pending">Pending</span>}
                                </dd>
                              </div>
                            </dl>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </>
              );
            })()}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
