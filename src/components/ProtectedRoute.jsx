import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function ProtectedRoute({ children, adminOnly = false }) {
  const { user, userProfile, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loader"></div>
        <p>Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (adminOnly && (!userProfile?.isAdmin)) {
    return <Navigate to="/dashboard" replace />;
  }

  // We use OTP verification during registration, not Firebase email verification.
  // Trust userProfile.emailVerified from Firestore; skip check for admin routes.
  if (!adminOnly && !user.emailVerified && !userProfile?.emailVerified) {
    return <Navigate to="/verify-email" replace />;
  }

  return children;
}
