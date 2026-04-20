import { useState, useEffect, useMemo } from 'react';
import { collection, addDoc, getDocs, query, where, deleteDoc, doc } from 'firebase/firestore';
import { db } from '../firebase/config';
import { useAuth } from '../context/AuthContext';
import { getAppTodayDate } from '../utils/calendarDate';
import { isPredictionEligible } from '../utils/match';
import {
  insightQuestionCountsTowardLimits,
  isInsightQuestionAnswerableInUi,
  isInsightQuestionVisibleInDashboard,
} from '../utils/insightQuestions';

function normAns(s) {
  return String(s ?? '').trim().toLowerCase();
}

const QUESTION_TYPES = [
  { value: 'yesno', label: 'Yes / No', options: ['Yes', 'No'] },
  { value: 'multiple', label: 'Multiple Choice', options: [] },
];

export default function CricketInsights({ matchId, matchDate, matchStatus, match: matchDoc, config = {} }) {
  const { user, userProfile } = useAuth();
  const maxPerUser = Math.max(1, parseInt(config.maxQuestionsPerUserPerMatch, 10) || 1);
  const maxPerMatch = Math.max(1, parseInt(config.maxQuestionsPerMatch, 10) || 5);
  const [questions, setQuestions] = useState([]);
  const [allMatchQuestions, setAllMatchQuestions] = useState([]);
  const [myAnswers, setMyAnswers] = useState({});
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [questionTitle, setQuestionTitle] = useState('');
  const [questionType, setQuestionType] = useState('yesno');
  const [questionOptions, setQuestionOptions] = useState(['', '']);
  const [answerInputs, setAnswerInputs] = useState({});
  const [answerLoading, setAnswerLoading] = useState({});
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [removingQid, setRemovingQid] = useState(null);

  const fetchQuestions = async (options = {}) => {
    const silent = options.silent === true;
    if (!matchId) {
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    setError('');
    try {
      const [approvedSnap, allSnap] = await Promise.all([
        getDocs(query(
          collection(db, 'cricket_questions'),
          where('matchId', '==', matchId),
          where('approved', '==', true)
        )),
        getDocs(query(collection(db, 'cricket_questions'), where('matchId', '==', matchId))),
      ]);
      const list = approvedSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(isInsightQuestionVisibleInDashboard)
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      setQuestions(list);
      setAllMatchQuestions(allSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error('Fetch questions error:', err);
      setError(err?.message || 'Failed to load questions. Please try again.');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const fetchMyAnswers = async () => {
    if (!user) return;
    try {
      const aSnap = await getDocs(
        query(collection(db, 'cricket_answers'), where('userId', '==', user.uid))
      );
      const map = {};
      aSnap.docs.forEach((d) => {
        const x = d.data();
        const qid = x.questionId != null ? String(x.questionId) : '';
        if (qid) map[qid] = x.answer;
      });
      setMyAnswers(map);
    } catch (err) {
      console.error('Fetch answers error:', err);
    }
  };

  useEffect(() => {
    fetchQuestions();
  }, [user, matchId]);

  const questionIdsKey = useMemo(() => questions.map((q) => q.id).sort().join(','), [questions]);

  useEffect(() => {
    if (questions.length > 0 && user) fetchMyAnswers();
  }, [user, questionIdsKey]);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(''), 5000);
    return () => clearTimeout(t);
  }, [success]);

  const handleOpenModal = () => {
    setQuestionTitle('');
    setQuestionType('yesno');
    setQuestionOptions(['', '']);
    setError('');
    setSuccess('');
    setShowModal(true);
  };

  const handleAddOption = () => {
    setQuestionOptions(prev => (prev.length >= 4 ? prev : [...prev, '']));
  };

  const handleOptionChange = (idx, val) => {
    setQuestionOptions(prev => {
      const next = [...prev];
      next[idx] = val;
      return next;
    });
  };

  const handleRemoveOption = (idx) => {
    setQuestionOptions(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSubmitQuestion = async (e) => {
    e.preventDefault();
    setError('');
    if ((matchStatus || '').toLowerCase() === 'completed') {
      setError('Match completed. Questions can no longer be asked.');
      return;
    }
    const windowOpen = matchDoc && matchDoc.date ? isPredictionEligible(matchDoc) : false;
    const allowQuestions =
      windowOpen || config.allowInsightQuestionsAfterPredictionCutoff === true;
    if (matchDoc && !allowQuestions) {
      setError(
        'Prediction cutoff has passed. You cannot submit new insight questions (unless your admin allows after-cutoff in program settings).'
      );
      return;
    }
    if (!questionTitle.trim() || !user) {
      setError('Please enter a question title.');
      return;
    }
    const myActive = allMatchQuestions.filter(
      q => q.createdBy === user.uid && insightQuestionCountsTowardLimits(q)
    );
    if (myActive.length >= maxPerUser) {
      setError(
        maxPerUser <= 1
          ? 'You already have an insight question for this match. If it was rejected, you can submit a new one.'
          : `You can only ask ${maxPerUser} question${maxPerUser > 1 ? 's' : ''} per match.`
      );
      return;
    }
    const matchSlotsUsed = allMatchQuestions.filter(insightQuestionCountsTowardLimits).length;
    if (matchSlotsUsed >= maxPerMatch) {
      setError(`Maximum ${maxPerMatch} questions per match reached.`);
      return;
    }
    const type = questionType;
    let options = [];
    if (type === 'yesno') options = ['Yes', 'No'];
    else if (type === 'multiple') options = questionOptions.filter(o => (o || '').trim());
    if (type === 'multiple' && options.length < 2) {
      setError('Multiple choice questions need at least 2 options. Please fill in the option fields.');
      return;
    }
    setSubmitting(true);
    try {
      await addDoc(collection(db, 'cricket_questions'), {
        matchId,
        question: questionTitle.trim(),
        type,
        options,
        createdBy: user.uid,
        createdAt: new Date().toISOString(),
        approved: false,
        approvedBy: [],
        correctAnswer: null,
        status: 'pending',
        answersDisabled: false,
      });
      setSuccess('Question submitted! It will appear here after admin approval.');
      setShowModal(false);
      fetchQuestions();
      setSubmitting(false);
    } catch (err) {
      console.error('Submit question error:', err);
      const msg = err?.message || 'Failed to submit question. Please try again.';
      const isPermissionError = /permission|insufficient/i.test(msg);
      setError(isPermissionError
        ? `${msg} Deploy Firestore rules: run \`npx firebase deploy --only firestore:rules\`. Ensure you're logged in.`
        : msg);
      setSubmitting(false);
    }
  };

  const handleSubmitAnswer = async (q) => {
    const qid = String(q.id);
    const answer = answerInputs[qid];
    if (answer == null || String(answer).trim() === '') return;
    if (myAnswers[qid]) return;
    if ((matchStatus || '').toLowerCase() === 'completed') {
      setError('This match is completed. You can no longer submit or change insight answers.');
      return;
    }
    const windowOpenAns = matchDoc && matchDoc.date ? isPredictionEligible(matchDoc) : false;
    const allowAnswers =
      windowOpenAns || config.allowInsightAnswersAfterPredictionCutoff === true;
    if (matchDoc && !allowAnswers) {
      setError(
        'Prediction cutoff has passed. You can no longer submit insight answers (unless your admin allows after-cutoff in program settings).'
      );
      return;
    }
    if (q.answersDisabled === true || !isInsightQuestionAnswerableInUi(q)) {
      setError('Answers are closed for this question.');
      return;
    }
    if (!user) {
      setError('Please log in to submit an answer.');
      return;
    }
    setError('');
    setAnswerLoading((prev) => ({ ...prev, [qid]: true }));
    try {
      const existsSnap = await getDocs(
        query(collection(db, 'cricket_answers'),
          where('questionId', '==', q.id),
          where('userId', '==', user.uid))
      );
      if (!existsSnap.empty) {
        const existing = existsSnap.docs[0].data().answer;
        setMyAnswers((prev) => ({ ...prev, [qid]: existing }));
        await fetchQuestions({ silent: true });
        setAnswerLoading((prev) => ({ ...prev, [qid]: false }));
        return;
      }
      await addDoc(collection(db, 'cricket_answers'), {
        questionId: q.id,
        userId: user.uid,
        answer: String(answer).trim(),
        createdAt: new Date().toISOString(),
      });
      setMyAnswers((prev) => ({ ...prev, [qid]: String(answer).trim() }));
      await fetchQuestions({ silent: true });
      await fetchMyAnswers();
    } catch (err) {
      console.error('Submit answer error:', err);
      const msg = err?.message || 'Failed to submit answer. Please try again.';
      const isPermissionError = /permission|insufficient/i.test(msg);
      setError(isPermissionError
        ? `${msg} Deploy Firestore rules: run \`npx firebase deploy --only firestore:rules\`. Ensure you're logged in.`
        : msg);
    }
    setAnswerLoading((prev) => ({ ...prev, [qid]: false }));
  };

  const handleDeleteQuestion = async (q) => {
    if (!confirm(`Permanently delete question: "${(q.question || '').slice(0, 50)}${(q.question || '').length > 50 ? '...' : ''}"? This cannot be undone.`)) return;
    setRemovingQid(q.id);
    try {
      await deleteDoc(doc(db, 'cricket_questions', q.id));
      setQuestions(prev => prev.filter(x => x.id !== q.id));
      setAllMatchQuestions(prev => prev.filter(x => x.id !== q.id));
      setSuccess('Question deleted.');
    } catch (err) {
      console.error('Delete question error:', err);
      setError(err?.message || 'Failed to delete question.');
    }
    setRemovingQid(null);
  };

  if (!matchId) return null;

  const isAdmin = userProfile?.isAdmin === true || userProfile?.isAdmin === 'true';

  const today = getAppTodayDate();
  const isTodayMatch = (matchDate || '') === today;
  const isMatchCompleted = (matchStatus || '').toLowerCase() === 'completed';
  const predictionWindowOpen = matchDoc && matchDoc.date ? isPredictionEligible(matchDoc) : false;
  const eligibleForQuestions =
    predictionWindowOpen || config.allowInsightQuestionsAfterPredictionCutoff === true;
  const eligibleForAnswers =
    predictionWindowOpen || config.allowInsightAnswersAfterPredictionCutoff === true;
  const myQuestionCount = allMatchQuestions.filter(
    q => q.createdBy === user?.uid && insightQuestionCountsTowardLimits(q)
  ).length;
  const totalCount = allMatchQuestions.filter(insightQuestionCountsTowardLimits).length;
  const canAskQuestion =
    user &&
    isTodayMatch &&
    !isMatchCompleted &&
    eligibleForQuestions &&
    myQuestionCount < maxPerUser &&
    totalCount < maxPerMatch;

  return (
    <div className="cricket-insights-inline">
      <h4 className="insight-section-title">💡 Cricket Insights</h4>
      <p className="muted insight-section-desc">
        {isMatchCompleted
          ? 'This match is completed. You can view questions and official answers; new answers and edits are not allowed.'
          : !predictionWindowOpen && !isMatchCompleted && !eligibleForQuestions && !eligibleForAnswers
            ? 'Prediction cutoff has passed. New questions and answers are disabled unless your admin enables after-cutoff options in program settings. When the official answer is set: +1 for correct; wrong answers may deduct points (see program config).'
            : 'Ask or answer questions for this match. +1 for correct answers; wrong answers may deduct points when the admin sets the official answer (program config).'}
      </p>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {success && <div className="alert alert-success" role="alert">{success}</div>}
      {canAskQuestion ? (
        <button type="button" className="btn btn-primary" onClick={handleOpenModal}>
          Ask Question
        </button>
      ) : (
        user && (
          isMatchCompleted
            ? <p className="muted">Match completed. Questions can no longer be asked.</p>
            : !eligibleForQuestions && isTodayMatch
              ? <p className="muted">Prediction cutoff has passed. New insight questions cannot be raised (unless your admin allows after-cutoff in program settings).</p>
            : !isTodayMatch
              ? <p className="muted">Questions can only be asked for today&apos;s matches.</p>
              : totalCount >= maxPerMatch
                ? <p className="muted">Maximum {maxPerMatch} questions per match reached.</p>
                : myQuestionCount >= maxPerUser && (
                  <p className="muted">
                    {maxPerUser <= 1
                      ? 'You already have an insight question for this match (pending or approved). If it was rejected, you can submit a new one.'
                      : `You can ask up to ${maxPerUser} questions per match.`}
                  </p>
                )
        )
      )}

      {loading ? (
        <p>Loading questions...</p>
      ) : questions.length === 0 ? (
        <p className="no-matches">No approved questions yet. Ask a question or wait for admin approval.</p>
      ) : (
        <div className="insights-questions-list">
          {questions.map((q) => {
            const qid = String(q.id);
            const answered = myAnswers[qid] != null && String(myAnswers[qid]).trim() !== '';
            const opts = q.options || [];
            const officialCorrect = (q.correctAnswer != null && String(q.correctAnswer).trim() !== '')
              ? String(q.correctAnswer).trim()
              : null;
            const canSubmit =
              !answered &&
              isInsightQuestionAnswerableInUi(q) &&
              !isMatchCompleted &&
              eligibleForAnswers;
            return (
              <div key={qid} className="insight-question-card">
                <div className="insight-question-header">
                  <div className="insight-question-content">
                    <h4>{q.question}</h4>
                    <p className="muted">Type: {QUESTION_TYPES.find(t => t.value === q.type)?.label || q.type}</p>
                  </div>
                  {isAdmin && (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger btn-icon-only"
                      onClick={() => handleDeleteQuestion(q)}
                      disabled={removingQid === q.id}
                      title={removingQid === q.id ? 'Removing...' : 'Permanently delete question (admin only)'}
                      aria-label="Delete"
                    >
                      {removingQid === q.id ? '⋯' : '🗑️'}
                    </button>
                  )}
                </div>
                {!answered && isMatchCompleted && (
                  <p className="muted insight-answers-closed">Match completed. Insight answers are closed.</p>
                )}
                {q.answersDisabled === true && !answered && !isMatchCompleted && (
                  <p className="muted insight-answers-closed">Answers are closed for this question.</p>
                )}
                {!answered && !eligibleForAnswers && !isMatchCompleted && isInsightQuestionAnswerableInUi(q) && (
                  <p className="muted insight-answers-closed">Prediction cutoff has passed. You can no longer submit an answer (unless your admin allows after-cutoff in program settings).</p>
                )}
                {answered && (
                  <div className="insight-answer-summary">
                    <p className="insight-answered">Your answer: <strong>{myAnswers[qid]}</strong></p>
                    {officialCorrect != null && (
                      <p className="insight-correct-answer">Correct answer: <strong>{officialCorrect}</strong></p>
                    )}
                    {officialCorrect != null && (
                      <p className="insight-result-hint">
                        {normAns(myAnswers[qid]) === normAns(officialCorrect) ? (
                          <span className="points-positive">You got it right.</span>
                        ) : (
                          <span className="points-negative">Official result: see correct answer above.</span>
                        )}
                      </p>
                    )}
                    {officialCorrect == null && (
                      <p className="muted insight-pending-correct">Official correct answer will appear when the admin sets it (usually after the match).</p>
                    )}
                  </div>
                )}
                {canSubmit && (
                  <div className="insight-answer-form">
                    {q.type === 'yesno' && (
                      <div className="insight-options">
                        {['Yes', 'No'].map(opt => (
                          <label key={opt} className="insight-option-radio">
                            <input
                              type="radio"
                              name={`q-${qid}`}
                              value={opt}
                              checked={(answerInputs[qid] || '') === opt}
                              onChange={() => setAnswerInputs(prev => ({ ...prev, [qid]: opt }))}
                            />
                            {opt}
                          </label>
                        ))}
                      </div>
                    )}
                    {q.type === 'multiple' && (
                      <div className="insight-options">
                        {opts.map(opt => (
                          <label key={opt} className="insight-option-radio">
                            <input
                              type="radio"
                              name={`q-${qid}`}
                              value={opt}
                              checked={(answerInputs[qid] || '') === opt}
                              onChange={() => setAnswerInputs(prev => ({ ...prev, [qid]: opt }))}
                            />
                            {opt}
                          </label>
                        ))}
                      </div>
                    )}
                    {q.type === 'text' && (
                      <input
                        type="text"
                        className="form-input"
                        placeholder="Your answer"
                        value={answerInputs[qid] || ''}
                        onChange={(e) => setAnswerInputs(prev => ({ ...prev, [qid]: e.target.value }))}
                      />
                    )}
                    {(answerInputs[qid] || '').trim() && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => handleSubmitAnswer(q)}
                        disabled={answerLoading[qid]}
                      >
                        {answerLoading[qid] ? 'Submitting...' : 'Submit Answer'}
                      </button>
                    )}
                  </div>
                )}
                {!answered && officialCorrect != null && (isMatchCompleted || q.answersDisabled === true) && (
                  <p className="insight-correct-answer insight-correct-only">Correct answer: <strong>{officialCorrect}</strong></p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => !submitting && setShowModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Ask Question</h3>
              <button type="button" className="modal-close" onClick={() => !submitting && setShowModal(false)} aria-label="Close">&times;</button>
            </div>
            <form onSubmit={handleSubmitQuestion}>
              {error && <div className="alert alert-error" role="alert">{error}</div>}
              <div className="form-group">
                <label>Question Title</label>
                <input
                  type="text"
                  value={questionTitle}
                  onChange={(e) => setQuestionTitle(e.target.value)}
                  placeholder="e.g. Will Virat Kohli score a half-century?"
                  required
                />
              </div>
              <div className="form-group">
                <label>Question Type</label>
                <select value={questionType} onChange={(e) => setQuestionType(e.target.value)}>
                  {QUESTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              {questionType === 'multiple' && (
                <div className="form-group">
                  <label>Options (up to 4)</label>
                  {questionOptions.map((opt, i) => (
                    <div key={i} className="form-row form-row-option">
                      <input
                        type="text"
                        value={opt}
                        onChange={(e) => handleOptionChange(i, e.target.value)}
                        placeholder={`Option ${i + 1}`}
                      />
                      <button type="button" className="btn btn-sm" onClick={() => handleRemoveOption(i)} disabled={questionOptions.length <= 2}>Remove</button>
                    </div>
                  ))}
                  <button type="button" className="btn btn-sm" onClick={handleAddOption} disabled={questionOptions.length >= 4}>Add Option</button>
                </div>
              )}
              <div className="modal-actions">
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Submitting...' : 'Submit'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)} disabled={submitting}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
