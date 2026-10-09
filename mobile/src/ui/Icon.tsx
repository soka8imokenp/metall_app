import React from 'react';
import {
  ArrowDownLeft, ArrowRight, ArrowUpRight, Bell, Briefcase, Building2, Camera, CameraOff, Check, ChevronDown, ChevronLeft, ChevronRight,
  ChevronsRight, CircleAlert, CircleCheck, CirclePlus, CircleX, Clock, CornerUpLeft, CreditCard, DollarSign, Eye, EyeOff, File, FileText,
  House, Image as ImageIcon, Inbox, Info, Layers, LayoutGrid, LogOut, Moon, Package, PenLine, Play, Plus, QrCode, Repeat, ScanLine, Search, Send,
  Download, Globe, RefreshCw, Settings, ShoppingBag, SquareCheck, Sun, Trash2, TrendingDown, TrendingUp, TriangleAlert, Truck, Wrench, WifiOff, X, Zap,
  type LucideIcon,
} from 'lucide-react-native';

/**
 * Иконки платформы — lucide, те же, что в вебе (lucide-react). Старые имена
 * в стиле Feather сохранены как ключи: экраны ссылаются на них, а картинка — lucide.
 */
const MAP = {
  'alert-circle': CircleAlert,
  'alert-triangle': TriangleAlert,
  'arrow-down-left': ArrowDownLeft,
  'arrow-right': ArrowRight,
  'arrow-up-right': ArrowUpRight,
  bell: Bell,
  briefcase: Briefcase,
  building: Building2,
  camera: Camera,
  'camera-off': CameraOff,
  check: Check,
  'check-circle': CircleCheck,
  'check-square': SquareCheck,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevrons-right': ChevronsRight,
  clock: Clock,
  'corner-up-left': CornerUpLeft,
  'credit-card': CreditCard,
  'dollar-sign': DollarSign,
  download: Download,
  'edit-3': PenLine,
  eye: Eye,
  'eye-off': EyeOff,
  file: File,
  'file-text': FileText,
  globe: Globe,
  grid: LayoutGrid,
  home: House,
  image: ImageIcon,
  inbox: Inbox,
  info: Info,
  layers: Layers,
  'log-out': LogOut,
  maximize: ScanLine,
  moon: Moon,
  package: Package,
  play: Play,
  plus: Plus,
  'plus-circle': CirclePlus,
  'qr-code': QrCode,
  repeat: Repeat,
  'refresh-cw': RefreshCw,
  search: Search,
  send: Send,
  settings: Settings,
  'shopping-bag': ShoppingBag,
  sun: Sun,
  tool: Wrench,
  'trash-2': Trash2,
  'trending-down': TrendingDown,
  'trending-up': TrendingUp,
  truck: Truck,
  'wifi-off': WifiOff,
  x: X,
  'x-circle': CircleX,
  zap: Zap,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof MAP;

export function Feather({ name, size = 20, color, strokeWidth = 1.9 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  const C = MAP[name] ?? Info;
  return <C size={size} color={color} strokeWidth={strokeWidth} />;
}
Feather.glyphMap = MAP;
