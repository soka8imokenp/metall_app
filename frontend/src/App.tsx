import React from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { firstAllowedModule, moduleAllowed } from './lib/modules';
import { AuthProvider, useAuth } from './context/AuthContext';
import { DashboardProvider } from './context/DashboardContext';
import { SalesProvider } from './context/SalesContext';
import { ProductionProvider } from './context/ProductionContext';
import { WarehouseProvider } from './context/WarehouseContext';
import { FinanceProvider } from './context/FinanceContext';
import { LoginScreen } from './components/auth/LoginScreen';
import { ChangePasswordScreen } from './components/auth/ChangePasswordScreen';
import { Sidebar } from './components/layout/Sidebar';
import { TopBar } from './components/layout/TopBar';
import { KpiCards } from './components/dashboard/KpiCards';
import { MonochromeAreaChart } from './components/dashboard/MonochromeAreaChart';
import { DataTableSection } from './components/dashboard/DataTableSection';
import { WarehouseView } from './components/modules/WarehouseView';
import { SalesView } from './components/modules/SalesView';
import { ProductionView } from './components/modules/ProductionView';
import { FinanceView } from './components/modules/FinanceView';
import { DocumentsView } from './components/modules/DocumentsView';
import { CrmView } from './components/modules/CrmView';
import { AdminView } from './components/modules/AdminView';
import { HelpView } from './components/help/HelpView';
import { GlobalSearchModal } from './components/modals/GlobalSearchModal';
import { UpdateBanner } from './components/UpdateBanner';

const AppContent: React.FC = () => {
  const { activeModule, setActiveModule } = useApp();
  const { can } = useAuth();

  /*
    Открытый раздел обязан быть разрешённым.

    Меню закрытых пунктов не рисует, но попасть в раздел можно и мимо меню:
    находкой из общего поиска, ссылкой из уведомления, сохранённым состоянием.
    Без этой сверки роль оказывалась на экране, где каждый запрос отвечает
    403, и выглядело это поломкой. Уводим на первый доступный — он же первый
    в меню, то есть ровно тот, на который человек нажал бы сам.
  */
  React.useEffect(() => {
    if (moduleAllowed(activeModule, can)) return;
    const first = firstAllowedModule(can);
    if (first && first !== activeModule) setActiveModule(first);
  }, [activeModule, can, setActiveModule]);

  // Кадр между сменой роли и срабатыванием сверки выше не должен успеть
  // сходить на сервер за чужими данными: провайдер раздела монтируется вместе
  // с разделом, и один такой кадр — это четыре запроса и четыре отказа.
  const show = (module: typeof activeModule) =>
    activeModule === module && moduleAllowed(module, can);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white dark:bg-[#09090b] text-[#09090b] dark:text-[#fafafa] font-sans antialiased">
      {/* Sidebar on left */}
      <Sidebar />

      {/* Inset Main Container matching image.png with rounded corners and border */}
      <div className="flex-1 flex flex-col min-w-0 h-[calc(100vh-16px)] m-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#09090b] shadow-xs overflow-hidden">
        {/* Top Header */}
        <TopBar />
        {/* Над содержимым: иначе полоса заедет под прокрутку таблицы. */}
        <UpdateBanner />

        {/* Scrollable Viewport */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-7 bg-white dark:bg-[#09090b]">
          <div className="max-w-[1400px] mx-auto flex flex-col gap-6">
            {show('dashboard') && (
              <>
                {/* 4 Metric Cards */}
                <KpiCards />

                {/* Layered Monochrome Area Chart */}
                <MonochromeAreaChart />

                {/* Dense Hairline Table Section */}
                <DataTableSection />
              </>
            )}

            {/* Провайдер продаж монтируется вместе с разделом: пока открыт
                дашборд, четыре запроса продаж серверу не нужны. */}
            {show('sales') && (
              <SalesProvider>
                <SalesView />
              </SalesProvider>
            )}
            {show('warehouse') && (
              <WarehouseProvider>
                <WarehouseView />
              </WarehouseProvider>
            )}
            {show('production') && (
              <ProductionProvider>
                <ProductionView />
              </ProductionProvider>
            )}
            {show('finance') && (
              <FinanceProvider>
                <FinanceView />
              </FinanceProvider>
            )}
            {show('documents') && <DocumentsView />}
            {show('crm') && <CrmView />}
            {show('admin') && <AdminView />}
            {show('help') && <HelpView />}
          </div>
        </main>
      </div>

      {/* Interactive Global Modals */}
      <GlobalSearchModal />
    </div>
  );
};

/**
 * Ворота: пока сессия не восстановлена из sessionStorage, ничего не рисуем —
 * иначе форма входа мигнёт у уже вошедшего пользователя, а дашборд успеет
 * сходить на сервер без токена и получить 401.
 */
const Gate: React.FC = () => {
  const { session, isReady } = useAuth();

  if (!isReady) {
    return <div className="h-screen w-screen bg-white dark:bg-[#09090b]" aria-hidden />;
  }

  // AppProvider стоит снаружи входа: он же ставит тему на <html>. Если
  // включать его только после логина, форма входа всегда будет светлой.
  if (!session) return <LoginScreen />;

  /*
    Временный пароль — это отдельный экран, а не окно поверх рабочего.

    Обойти его нечем: дальше по дереву ничего не отрисовано, поэтому ни один
    провайдер не пойдёт за данными и прятать нечего. Сервер при этом отвечает
    отказом на любой маршрут, кроме смены пароля и чтения профиля, — то есть
    даже собранный руками запрос из консоли ничего не вернёт. Признак снимает
    сервер, а не кнопка: экран уходит, когда перечитанный профиль его потерял.
  */
  if (session.mustChangePassword) return <ChangePasswordScreen />;

  return (
    <DashboardProvider>
      <AppContent />
    </DashboardProvider>
  );
};

export function App() {
  return (
    <AuthProvider>
      <AppProvider>
        <Gate />
      </AppProvider>
    </AuthProvider>
  );
}

export default App;
