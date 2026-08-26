export type Viewer = 'Jules' | 'Ravi';

export type JourneyScene = {
  key: string;
  eyebrow: string;
  status: string;
  statusTone: 'neutral' | 'info' | 'warning' | 'success';
  title: string;
  summary: string;
  activity: string[];
  connection: string;
  durableSequence: number;
  nextLabel: string;
  event: 'request' | 'status' | 'question' | 'answer' | 'working' | 'recovery' | 'resumed' | 'result';
};

export type Message = {
  author: 'Jules' | 'Ravi' | 'Alex';
  role: string;
  time: string;
  text: string;
  accent?: boolean;
};
