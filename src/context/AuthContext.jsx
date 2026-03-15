import { createContext, useContext, useState, useEffect } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { auth, db, callFunction } from '../firebase/config';
import { createAndSendOTP } from '../services/otp';

const AuthContext = createContext({});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let nullTimeout = null;

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        if (nullTimeout) clearTimeout(nullTimeout);
        try {
          const profilePromise = getDoc(doc(db, 'users', firebaseUser.uid));
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Profile fetch timeout')), 10000)
          );
          const profileDoc = await Promise.race([profilePromise, timeoutPromise]);
          setUserProfile(profileDoc?.exists?.() ? profileDoc.data() : null);
        } catch {
          setUserProfile(null);
        }
        setUser(firebaseUser);
        setLoading(false);
      } else {
        // Firebase may fire null briefly before restoring session on refresh.
        // Wait before treating as logged out so we don't redirect to login prematurely.
        nullTimeout = setTimeout(() => {
          setUser(null);
          setUserProfile(null);
          setLoading(false);
        }, 500);
      }
    });
    return () => {
      if (nullTimeout) clearTimeout(nullTimeout);
      unsubscribe();
    };
  }, []);

  const completeRegistration = async (email, username, password) => {
    const { user: newUser } = await createUserWithEmailAndPassword(auth, email, password);
    const usernameKey = username.toLowerCase().trim().replace(/\s+/g, '_');
    await setDoc(doc(db, 'users', newUser.uid), {
      email,
      username: usernameKey,
      isAdmin: false,
      emailVerified: true,
      passwordChangeCount: 0,
      insightPoints: 0,
      createdAt: new Date().toISOString(),
    });
    await setDoc(doc(db, 'usernameLookup', usernameKey), { email, userId: newUser.uid });
    return newUser;
  };

  const loginWithEmail = async (email, password) => {
    return signInWithEmailAndPassword(auth, email, password);
  };

  const loginWithUsername = async (username, password) => {
    const usernameKey = username.toLowerCase().trim().replace(/\s+/g, '_');
    const lookupDoc = await getDoc(doc(db, 'usernameLookup', usernameKey));
    if (!lookupDoc.exists()) throw new Error('User not found');
    const email = lookupDoc.data().email;
    return signInWithEmailAndPassword(auth, email, password);
  };

  const logout = () => signOut(auth);

  const forgotPassword = async (identifier) => {
    const trimmed = (identifier || '').trim();
    if (!trimmed) throw new Error('Enter your email or username');
    let email;
    let userId;
    if (trimmed.includes('@')) {
      email = trimmed.toLowerCase();
      const usersSnap = await getDocs(query(collection(db, 'users'), where('email', '==', email)));
      if (usersSnap.empty) throw new Error('User not found. Please register.');
      userId = usersSnap.docs[0].id;
    } else {
      const usernameKey = trimmed.toLowerCase().replace(/\s+/g, '_');
      const lookupDoc = await getDoc(doc(db, 'usernameLookup', usernameKey));
      if (!lookupDoc.exists()) throw new Error('User not found. Please register.');
      email = lookupDoc.data().email;
      userId = lookupDoc.data().userId;
    }
    const [userDoc, limit] = await Promise.all([
      getDoc(doc(db, 'users', userId)),
      getPasswordChangeLimit(),
    ]);
    const count = userDoc.exists() ? (userDoc.data().passwordChangeCount ?? 0) : 0;
    if (count >= limit) {
      throw new Error(`Password reset limit reached (max ${limit} per user). Contact admin.`);
    }
    await createAndSendOTP(email);
    return { email };
  };

  const resetPasswordWithOTP = async (email, otp, newPassword) => {
    try {
      const res = await callFunction('resetPasswordWithOTP', {
        email: email.trim().toLowerCase(),
        otp: otp.trim(),
        newPassword: newPassword.trim(),
      });
      if (res?.data?.success) return { success: true };
    } catch (err) {
      throw new Error(err?.message || 'Failed to reset password');
    }
    throw new Error('Failed to reset password');
  };

  const getSurrenderDeadline = async () => {
    try {
      const cfg = await getDoc(doc(db, 'settings', 'passwordPolicy'));
      return cfg.exists() ? (cfg.data().surrenderDeadline || null) : null;
    } catch {
      return null;
    }
  };

  const surrenderAccount = async () => {
    if (!user) throw new Error('Not logged in');
    const deadline = await getSurrenderDeadline();
    if (!deadline || !deadline.trim()) {
      throw new Error('Account surrender is not available. Contact admin.');
    }
    const today = new Date().toISOString().split('T')[0];
    if (today > deadline) {
      throw new Error(`Surrender period ended on ${deadline}. You can no longer surrender your account.`);
    }
    const usernameKey = (userProfile?.username || '').toLowerCase().trim().replace(/\s+/g, '_');
    const predsSnap = await getDocs(query(collection(db, 'predictions'), where('userId', '==', user.uid)));
    for (const d of predsSnap.docs) {
      try {
        await deleteDoc(doc(db, 'predictions', d.id));
      } catch {
        // ignore per-doc errors
      }
    }
    await deleteDoc(doc(db, 'users', user.uid));
    if (usernameKey) {
      try {
        await deleteDoc(doc(db, 'usernameLookup', usernameKey));
      } catch {
        // usernameLookup may not exist
      }
    }
    await signOut(auth);
  };

  const getPasswordChangeLimit = async () => {
    try {
      const cfg = await getDoc(doc(db, 'settings', 'passwordPolicy'));
      return cfg.exists() ? (cfg.data().maxPasswordChanges ?? 2) : 2;
    } catch {
      return 2;
    }
  };

  const changePassword = async (currentPassword, newPassword) => {
    if (!user) throw new Error('Not logged in');
    const credential = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, newPassword);
    return { success: true };
  };

  const changePasswordFromLogin = async (email, currentPassword, newPassword) => {
    const { user: signedInUser } = await signInWithEmailAndPassword(auth, email.trim(), currentPassword);
    try {
      await updatePassword(signedInUser, newPassword);
      return { success: true };
    } catch (err) {
      await signOut(auth);
      throw err;
    }
  };

  const value = {
    user,
    userProfile,
    loading,
    completeRegistration,
    loginWithEmail,
    loginWithUsername,
    logout,
    forgotPassword,
    resetPasswordWithOTP,
    surrenderAccount,
    getSurrenderDeadline,
    changePassword,
    changePasswordFromLogin,
    getPasswordChangeLimit,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
