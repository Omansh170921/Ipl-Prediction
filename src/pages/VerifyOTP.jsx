import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { useAuth } from '../context/AuthContext';
import { verifyOTP, resendOTP } from '../services/otp';

const PENDING_KEY = 'pendingRegistration';

export default function VerifyOTP() {
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const { user, completeRegistration } = useAuth();
  const navigate = useNavigate();
  const [pendingRedirect, setPendingRedirect] = useState(false);

  const [pending, setPending] = useState(null);

  useEffect(() => {
    if (user && pendingRedirect) {
      setPendingRedirect(false);
      navigate('/dashboard');
    }
  }, [user, pendingRedirect, navigate]);

  useAutoDismiss(error, setError);
  useAutoDismiss(message, setMessage);

  useEffect(() => {
    const data = sessionStorage.getItem(PENDING_KEY);
    if (!data) {
      navigate('/register');
      return;
    }
    try {
      setPending(JSON.parse(data));
    } catch {
      navigate('/register');
    }
  }, [navigate]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!pending || otp.length !== 6) return;

    setError('');
    setLoading(true);
    try {
      const { valid, error: err } = await verifyOTP(pending.email, otp);
      if (!valid) {
        setError(err);
        setLoading(false);
        return;
      }

      await completeRegistration(pending.email, pending.username, pending.password);
      sessionStorage.removeItem(PENDING_KEY);
      setPendingRedirect(true);
    } catch (err) {
      setError(err.message || 'Verification failed');
    }
    setLoading(false);
  };

  const handleResend = async () => {
    if (!pending || resendCooldown > 0) return;

    setError('');
    setMessage('');
    try {
      await resendOTP(pending.email);
      setMessage('New OTP sent! Check your email.');
      setResendCooldown(60);
    } catch (err) {
      setError(err.message || 'Failed to resend OTP');
    }
  };

  if (!pending) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Verify OTP</h1>
        <p className="auth-hint">
          Enter the 6-digit OTP sent to <strong>{pending.email}</strong>
        </p>
        {error && <div className="alert alert-error">{error}</div>}
        {message && <div className="alert alert-success">{message}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>OTP Code</label>
            <input
              type="text"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              maxLength={6}
              pattern="[0-9]{6}"
              inputMode="numeric"
              required
              className="otp-input"
            />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={loading || otp.length !== 6}>
            {loading ? 'Verifying...' : 'Verify & Create Account'}
          </button>
        </form>
        <button
          type="button"
          onClick={handleResend}
          className="btn btn-secondary btn-full"
          disabled={resendCooldown > 0}
        >
          {resendCooldown > 0 ? `Resend OTP (${resendCooldown}s)` : 'Resend OTP'}
        </button>
        <p className="auth-footer">
          <Link to="/register">Back to Register</Link>
        </p>
      </div>
    </div>
  );
}
