import type { Request, Response } from "express";
import { verifyCredentials, signToken } from "./authService.js";

export function createLoginHandler() {
  return function handleLogin(req: Request, res: Response): void {
    const { username, password } = req.body ?? {};

    if (typeof username !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "username and password are required" });
      return;
    }

    if (!verifyCredentials(username, password)) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    res.status(200).json({ token: signToken(username) });
  };
}
