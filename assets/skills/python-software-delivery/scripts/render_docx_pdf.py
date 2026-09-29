# -*- coding: utf-8 -*-
"""用 Word COM 后台把 docx 转 PDF 并读取真实页数（不显示界面）。"""
import sys, os, time
import win32com.client as win32

def render(src, dst):
    src = os.path.abspath(src)
    dst = os.path.abspath(dst)
    word = win32.DispatchEx("Word.Application")
    word.Visible = False
    word.DisplayAlerts = 0
    try:
        doc = word.Documents.Open(src, ReadOnly=True, AddToRecentFiles=False)
        # 更新域（NUMPAGES/PAGE），使页脚统计正确
        try:
            doc.Fields.Update()
            for s in doc.Sections:
                for hf in list(s.Headers) + list(s.Footers):
                    hf.Range.Fields.Update()
        except Exception:
            pass
        doc.Repaginate()
        pages = doc.ComputeStatistics(2)  # wdStatisticPages
        words = doc.ComputeStatistics(0)  # wdStatisticWords
        chars = doc.ComputeStatistics(3)  # wdStatisticCharacters
        doc.SaveAs(dst, FileFormat=17)     # wdFormatPDF
        doc.Close(False)
        return pages, words, chars
    finally:
        try:
            word.Quit()
        except Exception:
            pass

if __name__ == "__main__":
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(src)[0] + ".pdf"
    t0 = time.time()
    pages, words, chars = render(src, dst)
    print("PDF       :", dst)
    print("真实页数  :", pages)
    print("Word统计字数:", words)
    print("Word统计字符:", chars)
    print("耗时(秒)  : %.1f" % (time.time() - t0))
