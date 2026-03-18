import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Register from './pages/Register';
import VerifyEmail from './pages/VerifyEmail';
import VerifyOTP from './pages/VerifyOTP';
import ForgotPasswordVerify from './pages/ForgotPasswordVerify';
import AdminLogin from './pages/AdminLogin';
import LoginPasswordOptions from './pages/LoginPasswordOptions';
import Dashboard from './pages/Dashboard';
import Admin from './pages/Admin';
import InsightApproval from './pages/InsightApproval';
import './App.css';
import { requestNotificationPermission, saveFCMTokenToUser } from './notification';
import { useEffect } from 'react';
import { useAuth } from './context/AuthContext';

function NotificationRegistration() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.uid) return;

    async function register() {
      const token = await requestNotificationPermission();
      if (token) {
        await saveFCMTokenToUser(user.uid, token);
      }
    }
    register();
  }, [user?.uid]);

  return null;
}

function App() {

  return (
    <AuthProvider>
      <NotificationRegistration />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/verify-otp" element={<VerifyOTP />} />
          <Route path="/forgot-password-verify" element={<ForgotPasswordVerify />} />
          <Route path="/admin-login" element={<AdminLogin />} />
          <Route path="/login-password" element={<LoginPasswordOptions />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute adminOnly>
                <Admin />
              </ProtectedRoute>
            }
          />
          <Route
            path="/insight-approval"
            element={
              <ProtectedRoute>
                <InsightApproval />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
