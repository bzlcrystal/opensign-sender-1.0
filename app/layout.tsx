import "./globals.css";
import type { Metadata } from "next";
export const metadata: Metadata = { title: "Envoi OpenSign", description: "Envoi de documents pour signature" };
export default function RootLayout({children}:{children:React.ReactNode}) { return <html lang="fr"><body>{children}</body></html>; }
