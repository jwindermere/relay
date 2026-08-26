declare global {
  namespace App {
    interface Locals {
      authenticated: {
        sessionId: string;
        userId: string;
        email: string;
        emailVerified: boolean;
      } | null;
    }
  }
}

export {};
