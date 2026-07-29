/* من سجلّ ناف: fahadaali/naf-ui — العنصر «utils».
   منقول كما هو. لا تعدّل هذا الملف — أي تغيير يحدث في السجلّ أولاً. */

import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
