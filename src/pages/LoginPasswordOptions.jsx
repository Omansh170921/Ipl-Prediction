import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { useAuth } from '../context/AuthContext';

export default function LoginPasswordOptions() {
  const [fpEmail, setFpEmail] = useState('');
  const [fpLoading, setFpLoading] = useState(false);
  const [cpEmail, setCpEmail] = useState('');
  const [cpCurrentPassword, setCpCurrentPassword] = useState('');
  const [cpNewPassword, setCpNewPassword] = useState('');
  const [cpConfirmPassword, setCpConfirmPassword] = useState('');
  const [cpLoading, setCpLoading] = useState(false);
  const [cpSuccess, setCpSuccess] = useState('');
  const [error, setError] = useState('');
  const { changePasswordFromLogin, forgotPassword } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setError('');
    setCpSuccess('');
    if (cpNewPassword !== cpConfirmPassword) {
      setError('New passwords do not match');
      return;
    }
    if (cpNewPassword.length < 6) {
      setError('New password must be at least 6 characters');
      return;
    }
    if (!cpEmail.trim() || !cpCurrentPassword) {
      setError('Email and current password are required');
      return;
    }
    setCpLoading(true);
    try {
      await changePasswordFromLogin(cpEmail.trim(), cpCurrentPassword, cpNewPassword);
      setCpSuccess('Password changed successfully. Redirecting to login...');
      setTimeout(() => navigate('/login', { replace: true, state: { message: 'Password changed successfully. You can now login.' } }), 1500);
    } catch (err) {
      const msg = err?.message || '';
      setError(msg.includes('limit') ? msg : 'Invalid credential please validate.');
    }
    setCpLoading(false);
  };

  useAutoDismiss(error, setError);
  useAutoDismiss(cpSuccess, setCpSuccess);

  useEffect(() => {
    if (!location.state?.message) return;
    const t = setTimeout(() => {
      navigate(location.pathname, { replace: true, state: { ...location.state, message: undefined } });
    }, 3000);
    return () => clearTimeout(t);
  }, [location.state?.message, location.pathname, location.state, navigate]);

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    setError('');
    if (!fpEmail.trim()) {
      setError('Enter your email or username');
      return;
    }
    setFpLoading(true);
    try {
      const { email } = await forgotPassword(fpEmail.trim());
      sessionStorage.setItem('pendingForgotPassword', JSON.stringify({ email }));
      navigate('/forgot-password-verify', { state: { email } });
    } catch (err) {
      setError(err?.message || 'Failed to send OTP.');
    }
    setFpLoading(false);
  };

  return (
    <div className="auth-page">
      <div className="auth-card auth-card-wide">
        <h1>Change & Reset Password</h1>
        <p className="auth-hint">Change your password or reset it via OTP if you forgot.</p>
        {location.state?.message && <div className="alert alert-success">{location.state.message}</div>}
        {error && <div className="alert alert-error">{error}</div>}
        <div className="login-password-sections">
          <div className="change-password-section">
            <h3>Change Password</h3>
            <p className="muted">Enter your email, current password, and new password. No limit applies.</p>
            {cpSuccess && <div className="alert alert-success">{cpSuccess}</div>}
            <form onSubmit={handleChangePassword}>
              <div className="form-group">
                <label>Email</label>
                <input type="email" value={cpEmail} onChange={(e) => setCpEmail(e.target.value)} placeholder="your@email.com" required />
              </div>
              <div className="form-group">
                <label>Current Password</label>
                <input type="password" value={cpCurrentPassword} onChange={(e) => setCpCurrentPassword(e.target.value)} placeholder="Current password" required />
              </div>
              <div className="form-group">
                <label>New Password</label>
                <input type="password" value={cpNewPassword} onChange={(e) => setCpNewPassword(e.target.value)} placeholder="Min 6 characters" minLength={6} required />
              </div>
              <div className="form-group">
                <label>Confirm New Password</label>
                <input type="password" value={cpConfirmPassword} onChange={(e) => setCpConfirmPassword(e.target.value)} placeholder="Confirm new password" minLength={6} required />
              </div>
              <button type="submit" className="btn btn-primary btn-full" disabled={cpLoading}>{cpLoading ? 'Changing...' : 'Change Password'}</button>
            </form>
          </div>
          <div className="change-password-section">
            <h3>Forgot Password</h3>
            <p className="muted">Enter your email or username. We&apos;ll send a 6-digit OTP. Max resets per user is set in Admin → Program Config.</p>
            <form onSubmit={handleForgotPassword}>
              <div className="form-group">
                <label>Email or Username</label>
                <input type="text" value={fpEmail} onChange={(e) => setFpEmail(e.target.value)} placeholder="your@email.com or username" required />
              </div>
              <button type="submit" className="btn btn-primary btn-full" disabled={fpLoading}>{fpLoading ? 'Sending OTP...' : 'Send OTP'}</button>
            </form>
          </div>
        </div>
        <p className="auth-footer">
          <Link to="/login">Back to Login</Link>
        </p>
      </div>
    </div>
  );
}
