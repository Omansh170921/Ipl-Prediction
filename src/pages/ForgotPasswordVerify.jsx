import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { useAuth } from '../context/AuthContext';
import { resendOTP } from '../services/otp';

const PENDING_KEY = 'pendingForgotPassword';

export default function ForgotPasswordVerify() {
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const { resetPasswordWithOTP } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [pending, setPending] = useState(null);

  useAutoDismiss(error, setError);
  useAutoDismiss(message, setMessage);

  useEffect(() => {
    const email = location.state?.email || (() => {
      try {
        const data = sessionStorage.getItem(PENDING_KEY);
        return data ? JSON.parse(data).email : null;
      } catch {
        return null;
      }
    })();
    if (email) {
      setPending({ email });
    } else {
      navigate('/login', { replace: true });
    }
  }, [location.state?.email, navigate]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!pending || otp.length !== 6) return;
    setError('');
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    setLoading(true);
    try {
      await resetPasswordWithOTP(pending.email, otp, newPassword);
      sessionStorage.removeItem(PENDING_KEY);
      navigate('/login', { replace: true, state: { message: 'Password reset successfully. You can now login.' } });
    } catch (err) {
      setError(err?.message || err?.details || 'Failed to reset password');
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
        <h1>Reset Password</h1>
        <p className="auth-hint">
          Enter the 6-digit OTP sent to <strong>{pending.email}</strong> and your new password.
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
          <div className="form-group">
            <label>New Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Min 6 characters"
              minLength={6}
              required
            />
          </div>
          <div className="form-group">
            <label>Confirm New Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              minLength={6}
              required
            />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={loading || otp.length !== 6}>
            {loading ? 'Resetting...' : 'Reset Password'}
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
          <Link to="/login">Back to Login</Link>
        </p>
      </div>
    </div>
  );
}
