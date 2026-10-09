import React, { createContext, useContext, useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

/**
 * Режим «только онлайн»: без связи экраны показывают последнее, что успели
 * загрузить, а любое изменение запрещено. Флаг один на всё приложение.
 */
const Ctx = createContext(true);

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const unsub = NetInfo.addEventListener((s) => {
      setOnline(s.isConnected !== false && s.isInternetReachable !== false);
    });
    return unsub;
  }, []);
  return <Ctx.Provider value={online}>{children}</Ctx.Provider>;
}

export const useOnline = () => useContext(Ctx);
