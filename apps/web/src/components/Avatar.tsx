import type { AssistantEmotion, SessionState } from "@companion/shared";

export interface AvatarProps {
  name: string;
  /** 本轮回复的情绪，由服务端下发。 */
  emotion: AssistantEmotion;
  state: SessionState;
}

/** 不同情绪下的嘴形。 */
const MOUTH: Record<AssistantEmotion, string> = {
  neutral: "M46 79 Q60 85 74 79",
  happy: "M43 75 Q60 93 77 75",
  excited: "M41 74 Q60 99 79 74",
  caring: "M47 79 Q60 87 73 79",
  sad: "M46 85 Q60 76 74 85",
  angry: "M47 83 Q60 77 73 83",
};

/** 纯 SVG 的小形象：随情绪换表情，随会话状态做小动作。 */
export function Avatar({ name, emotion, state }: AvatarProps) {
  const closedEyes = emotion === "happy" || emotion === "excited";
  const blush = emotion === "happy" || emotion === "excited" || emotion === "caring";

  return (
    <div
      className={`avatar avatar-${emotion} is-${state}`}
      role="img"
      aria-label={`${name}，${emotion}`}
    >
      <svg viewBox="0 0 120 132" aria-hidden="true">
        <ellipse className="avatar-shadow" cx="60" cy="124" rx="30" ry="5" />
        <path className="avatar-body" d="M28 128 Q28 100 60 100 Q92 100 92 128 Z" />
        <circle className="avatar-face" cx="60" cy="62" r="42" />
        <g className="avatar-antenna">
          <line x1="60" y1="22" x2="60" y2="32" />
          <circle className="avatar-antenna-dot" cx="60" cy="18" r="4" />
        </g>

        <g className="avatar-eyes">
          {closedEyes ? (
            <>
              <path d="M38 58 Q46 50 54 58" />
              <path d="M66 58 Q74 50 82 58" />
            </>
          ) : (
            <>
              <ellipse cx="46" cy="57" rx="4.2" ry="5.4" />
              <ellipse cx="74" cy="57" rx="4.2" ry="5.4" />
            </>
          )}
        </g>

        {blush && (
          <g className="avatar-blush">
            <ellipse cx="35" cy="72" rx="6" ry="3.2" />
            <ellipse cx="85" cy="72" rx="6" ry="3.2" />
          </g>
        )}

        <g className="avatar-brows">
          {emotion === "angry" && <path d="M38 45 L54 50 M82 45 L66 50" />}
          {emotion === "sad" && <path d="M38 51 L54 46 M82 51 L66 46" />}
        </g>

        <path className="avatar-mouth" d={MOUTH[emotion]} />
        {emotion === "sad" && <path className="avatar-tear" d="M79 64 q3 6 0 9 q-3 -3 0 -9" />}

        {state === "thinking" && (
          <g className="avatar-think">
            <circle cx="96" cy="30" r="3" />
            <circle cx="104" cy="23" r="2.2" />
          </g>
        )}
      </svg>
    </div>
  );
}
